# Security policy

## Supported versions

Reel is pre-1.0. Fixes land on the latest release; there are no maintained
release branches yet.

| Version | Supported |
| ------- | --------- |
| 0.x (latest) | ✅ |
| older 0.x | ❌ |

## Reporting a vulnerability

Please report privately, not in a public issue.

Use GitHub's **[private vulnerability reporting](https://github.com/KirtiJha/reel/security/advisories/new)**
(the *Security* tab → *Report a vulnerability*). It creates a private thread
with the maintainers and needs no email address.

If that form isn't available, open a public issue saying only that you have a
security report and asking for a private channel — please don't include details
in it.

What helps:

- what an attacker can do, and what they need to start (a spec you can make a
  user run? a page the demo visits? access to the Studio port?)
- the smallest `.reel.yaml` or page that reproduces it
- version (`reel --version`), OS, and Node version

Expect an acknowledgement within a week. Reel is maintained by volunteers; there
is no bounty, and we'll credit you in the advisory unless you'd rather we didn't.

## What is, and isn't, a vulnerability

**A `.reel.yaml` is executable code.** `run.cmd` boots your app through a shell,
and terminal `run:` steps execute real commands — that's the feature. Running a
spec you didn't write is equivalent to running a shell script you didn't write.
Reports that a spec can run commands are *by design* and won't be treated as
vulnerabilities.

Set `REEL_NO_EXEC=1` to make Reel refuse to spawn either. Start the app yourself
and point `url:` at it instead.

These, on the other hand, we do want to hear about:

- escaping the working-directory restriction on Studio file and media requests
- the Studio (which binds `127.0.0.1` only) becoming reachable off-host
- spec content executing in the generated interactive HTML, or in the Studio
- secrets surviving into rendered media along a path the docs claim is redacted
- anything that turns *recording a demo of a hostile page* into code execution
  on the recording machine

## Running Reel safely

- **Never record an untrusted spec in a job that holds secrets or write
  permissions.** The CI story invites running specs from pull requests; a fork's
  PR can change the spec. The bundled workflow restricts write-back to same-repo
  PRs for exactly this reason.
- **`storageState` is a live session.** It holds cookies for a logged-in demo —
  treat it as a credential and keep it out of the repository.
- **Recordings capture whatever is on screen.** Real customer data, tokens in a
  URL bar, and email addresses all render into the GIF. Use `redact:` to blur or
  box them, and `mock:` to pin responses to fixtures instead of live data.
- **The Studio is a local dev tool.** It reads and writes files under the
  directory you launched it in, and it is not hardened for exposure. Don't
  forward its port.
