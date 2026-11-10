# Security policy

## Supported versions

This project is a source fork under active development.
No production security-support release series has been declared.
The original Rust package remains `miniquad` version `0.4.11`.
See [MADR 0007](docs/adr/0007-use-supported-and-secure-toolchains.md) for the toolchain review policy.

## Report a vulnerability

Use [GitHub's private vulnerability reporting feature](https://github.com/Tigon32/miniquad/security/advisories/new) if the repository offers it.
Do not publish proof-of-concept exploit code or credentials in a public issue.
If private reporting is not available, contact the repository owner through an existing private channel.
Do not assume that a public issue is a private report.

Include the affected commit or version, environment, reproduction steps, possible impact, and suggested mitigation.
Do not include personal data, tokens, or secrets.

## Handling and disclosure

The maintainer will triage reported issues and check the affected source and supported targets.
Actively exploited, applicable vulnerabilities have a target triage time of 24 hours from discovery.
This is a triage target, not a guaranteed patch or response time.
A correction requires tests and review before a release.
Coordinated disclosure should allow reasonable time for a correction and user notification.

## Current limitations

The project has not completed a full security audit.
The browser bridge accepts external input and uses JavaScript/WASM memory transfers.
The native backends also have platform-specific code and unsafe interfaces.
A successful CI build does not establish memory safety or browser security.

Security work and known gaps are tracked in [issue #16](https://github.com/Tigon32/miniquad/issues/16).
