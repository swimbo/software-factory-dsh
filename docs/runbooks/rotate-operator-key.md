# Runbook: rotating the operator signing key

**Severity:** high — until a valid public key is published, **every** promotion is refused with
`PROMOTION_UNSIGNED` (exit `5`) and no artifact is written.
**Exit codes you will see:** `5` when the signature does not verify; `0` with a `promotion.yaml`
path and a `git apply` line when it does.

## How the key is used (read this first)

`factory promote` is the human gate: v1 emits a patch plus a signed promotion record, and applying
it is your action outside the tool. The tool **verifies** signatures; it never holds a private key
and never signs anything.

- Public key, in this order: `FACTORY_OPERATOR_KEY` (a path to a PEM file), then
  `$FACTORY_HOME/keys/operator.pub.pem`, then `$FACTORY_HOME/keys/operator.ed25519.pub`.
- Signature: ed25519 over a `sha256:…` payload, ASCII-armoured between
  `-----BEGIN SIGNATURE-----` / `-----END SIGNATURE-----`, passed with
  `--signature <path-or-literal>` (a path is read; anything else is used verbatim).
- The payload is `contentHash({ unitId, verdictSha, approvedBy })`, where `verdictSha` is
  `contentHash(verdict)` of the unit's latest **verdict body** and `approvedBy` is the value of
  `--signed-by` (default `operator`). The refusal message prints the payload hash it wants:
  "promotion requires a human signature over sha256:…".
- The key's identity is `keyId(publicKeyPem)` → `ed25519:<8 hex>`, recorded on the promotion.

## Symptom

`factory promote` refuses, and the message names the payload:

```
PROMOTION_UNSIGNED: promotion requires a human signature over sha256:b9fb2326…;
none was provided and none can be synthesized. No artifact was written.
```

Two distinct causes look identical here: (a) no `--signature` at all, (b) a signature that does not
verify against the **currently published** public key. After a rotation, (b) is the expected
symptom of an old key.

## What the factory will refuse to do

- **Sign for you.** There is no `factory sign` verb and no key material in the store or the CLI
  (`packages/gates/src/signing.ts` only ever verifies; `signPayload` is a library function for you
  and for tests, not a verb).
- **Accept a stale key.** Verification is against the key published _now_; the moment
  `operator.pub.pem` changes, every signature made with the retired private key stops verifying.
- **Write anything on a refusal.** No `promotion.yaml`, no record: "No artifact was written."
  There is also no `--force`.

## Procedure (verified end-to-end on this tree)

```bash
export PATH="$HOME/.nvm/versions/node/v$(cat .nvmrc)/bin:$PATH"
KEYDIR="$HOME/.factory-operator-keys"      # outside the repo: it holds a private key
mkdir -p "$KEYDIR"

# 1. Generate the new keypair. Keep the private half off this host if your policy says so;
#    only the public half is ever published to the factory.
node --input-type=module -e '
import { writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
const dir = process.env.KEYDIR;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
writeFileSync(dir + "/operator.ed25519.new.pem", privateKey.export({ format: "pem", type: "pkcs8" }));
writeFileSync(dir + "/operator.pub.new.pem", publicKey.export({ format: "pem", type: "spki" }));
'

# 2. Publish the public half. This is the whole rotation: the file the tool reads changes.
mkdir -p "$FACTORY_HOME/keys"
cp "$KEYDIR/operator.pub.new.pem" "$FACTORY_HOME/keys/operator.pub.pem"
#    (or: export FACTORY_OPERATOR_KEY="$KEYDIR/operator.pub.new.pem")

# 3. Sign the payload the gate asks for, using the repo's own canonical hashing.
#    Run this from the repository root so the relative imports resolve.
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { contentHash } from "./packages/contracts/src/index.ts";
import { signPayload } from "./packages/gates/src/index.ts";
const [unitId, approvedBy] = process.argv.slice(1);
const store = (await import("./packages/store/src/index.ts")).openStore({
  dir: process.env.FACTORY_HOME + "/state",
});
const row = store.latestVerdictForUnit(unitId);
store.close();
if (row === null) throw new Error("no verdict for " + unitId);
const payload = contentHash({ unitId, verdictSha: contentHash(row.verdict), approvedBy });
writeFileSync(process.env.KEYDIR + "/promotion.sig", signPayload(payload, readFileSync(process.env.KEYDIR + "/operator.ed25519.new.pem", "utf8")));
console.log("signed", payload);
' <unitId> operator

# 4. Promote with the signature and the typed phrase.
#    `factory` is a pnpm script (`node apps/cli/src/main.ts`); use it directly if you have not
#    installed a shim.
pnpm run factory promote <unitId> \
  --signature "$KEYDIR/promotion.sig" \
  --signed-by operator \
  --confirm "sign promotion <unitId>"
```

Success prints the artifact and the apply instructions:

```
  apply           git apply <FACTORY_HOME>/artifacts/<unitId>/…/change.patch
  inspect         factory audit <unitId>
  gate            first-promotion-only (this was the first signing of this unit)
```

`--signature` also accepts the armoured text itself, so a signature can travel through a shell
variable instead of a file.

## What "fixed" looks like

- `factory promote` exits `0`, writes `promotion.yaml` under the artifacts directory, and the
  ledger holds a `promotion` row with `human_key_id` = the new key's `ed25519:<8 hex>`.
- A deliberately stale signature (made with the retired key) is refused with exit `5` and no
  artifact — which is the rotation _working_.
- Past promotions keep the key id they were signed with; rotation does not rewrite history, so old
  records still name the old key and remain auditable.

## If it does not work

- **`PROMOTION_UNSIGNED` with the new key and a fresh signature.** Check, in order: the payload hash
  in the message equals the one your signing script printed (if not, `approvedBy` differs — pass the
  same `--signed-by` you signed with, or omit both); `$FACTORY_HOME/keys/operator.pub.pem` is the
  new PEM (not a private key); the file has `-----BEGIN PUBLIC KEY-----`; there is exactly one
  `--signature` value and it is the armour, not a path that does not exist.
- **The refusal says "none was provided" even though you passed `--signature`.** The wording is
  wrong for the "present but does not verify" case (it is the same message as the missing-signature
  case). Treat it as "did not verify" and re-check the payload, not the flag.
- **`factory promote` refuses for a reason other than the signature** (exit `5` for `VERDICT_UNKNOWN`,
  `3` for policy): an `unknown` verdict can never be signed — that is ADR-003, not a key problem.
- **You rotated the key by accident and want the old one back.** Re-publish the previous public PEM;
  the tool has no notion of a key history, so the previous key starts verifying again immediately.
  The promotions already recorded keep their own `human_key_id`, so the audit trail stays honest
  either way — but tell the operator group, because a retired key that verifies again is exactly
  the ambiguity this procedure exists to avoid.

**Not built.** There is no key registry, no rotation ledger entry, no expiry and no revocation list:
`$FACTORY_HOME/keys/` (or `FACTORY_OPERATOR_KEY`) is one file that the next command reads
([`phase-13-audit.md`](../planning/dark-factory-dsh/phase-13-audit.md) Phase 9c/9d). Do not expect
the tool to tell you a key is old.
