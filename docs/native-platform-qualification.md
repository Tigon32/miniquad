# Native platform qualification

* Date: 2026-11-10
* Review: **Source-based qualification record**, not a release approval

## Android

The existing manual CI used the Docker image `notfl3/cargo-apk` without a digest.
This fork has not verified the image source, build inputs, software support status, or security updates.
The image was used through a mutable tag.
The old Android build job has been disabled.

**State:** Android build and runtime behavior are **not tested** by the current CI.
Do not report the Android target as supported or qualified based on an earlier green workflow.
The Rust Android backend remains in the source tree.

### Restore a verified job

1. Select a currently supported Android SDK, NDK, and Rust compiler.
2. Pin the exact tool versions and container digest, if a container is necessary.
3. Review the container Dockerfile and source of the base image.
4. Check known advisories and the licence requirements.
5. Run a native Android build and an actual device test.
6. Record the build inputs and results.
7. Add the job behind `workflow_dispatch`.
8. Do not run an unverified container merely to make a test appear green.

The same source and runtime evidence rules apply to other native targets.
See [security issue #16](https://github.com/Tigon32/miniquad/issues/16) and [release issue #19](https://github.com/Tigon32/miniquad/issues/19).

**Writing review:** STE-aligned draft. Full dictionary review not done.
