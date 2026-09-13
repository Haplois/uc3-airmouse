# Prepare a public source release

## Keep device data private

Use your actual SSH destinations through each tool's `--host`, `--tv`, or
`--remote` flags. Hosts ending in `.example` are placeholders.

For the three identity-scoped tools below, pass the paired Remote 3's Bluetooth
address explicitly with `--remote3-address`:

- `airmouse-lg-deploy-receiver` when using `--binary`.
- `airmouse-lg-check-key-route`.
- `airmouse-lg-clear-pairings`, which also requires `--original-address`.

The addresses must be distinct when clearing both remotes. Never substitute
the example addresses from tests. The reboot checker obtains the secondary
address from the TV's protected slot configuration and passes it to the key check.
The firmware checksum, active-connection, and original-remote checks remain in place.

Keep credentials, raw Bluetooth captures, proprietary firmware, pairing databases,
and device backups outside the repository. The ignore rules cover common private
artifacts and the root `private/`, `backups/`, and `captures/` directories.
Ignore rules do not remove previously tracked files or prevent `git add --force`.

## Run the checks

Before committing, run:

```sh
python3 tools/check-public
python3 tools/check-docs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test -p publication_test.py
gitleaks dir . --redact
gitleaks git . --log-opts=--all --redact
```

`check-public` checks tracked and untracked, nonignored working-tree files for
private artifact names, workstation paths, and private network addresses.
Tests may contain synthetic private-network addresses. Gitleaks checks for
credential patterns. Neither check guarantees that every private detail is absent.

The publication workflow runs on pushes and pull requests with read-only repository
permissions. It scans an index export and reachable Git history. Its checkout
action is pinned to a commit, and its Gitleaks download is checksum-pinned.
It does not deploy or contact a TV or remote.

## Decide what history to publish

The September 13 cleanup changes current files only. Earlier commits still contain
the lab's device identifiers and workstation paths. The September 11 credential
scan found no secrets in staged files or the 61 commits then reachable locally.
That result does not mean the history contains no identifying information.
The September 13 rescan found no secrets in the revised working-tree snapshot
or the 66 commits then reachable locally, including checkpoint refs.

Before changing visibility, choose whether to publish the existing history,
rewrite it after taking a private backup, or publish a clean source snapshot
in a separate repository. Rewriting history and changing visibility require
separate approval. Do not mirror local checkpoint refs or private archives.

## Preserve licensing and attribution

Keep [LICENSE](../LICENSE), [native/LICENSE](../native/LICENSE), the kernel
license, and [logo attribution](../native/ASSETS.md). The project is not entirely
MIT-licensed. Review the GPL requirements and BTstack restrictions before
distributing compiled releases. Do not publish the proprietary LG executable.
Logo attribution does not resolve every trademark question.
