# Pin the Nixpkgs input to a reviewed, immutable commit.
#
# `<nixpkgs>` reads a local Nix channel. That channel is not part of this
# repository and can differ between machines and over time. This file
# replaces it with a fixed source, so `nix-shell` builds the same
# dependency versions until a reviewer updates the pin below.
#
# Source: https://github.com/NixOS/nixpkgs
# Pinned branch: `release-26.05` (the current Nixpkgs stable release
# branch; see https://github.com/NixOS/nixpkgs/branches).
# Pinned commit: 41992211735edd8f46bb3d443abf0bffcfd71870
# Reviewed on: 2026-11-11, from
#   https://github.com/NixOS/nixpkgs/commits/release-26.05
#
# Update method (run from a machine with `nix` installed):
# 1. Select a reviewed commit from an official Nixpkgs release or
#    channel branch (for example `release-26.05`). Do not pin an
#    arbitrary fork or an unreviewed pull-request branch.
# 2. Compute the hash `fetchTarball` actually checks: the hash of the
#    *unpacked* NAR, not a plain `sha256sum`/`shasum` of the `.tar.gz`
#    bytes. Those are different hashes; using the raw-tarball hash
#    fails with a `NAR hash mismatch` error.
#      nix-prefetch-url --unpack --type sha256 \
#        "https://github.com/NixOS/nixpkgs/archive/<rev>.tar.gz"
#    This prints a base32 hash. Convert it to the SRI form used below
#    with:
#      nix --extra-experimental-features nix-command hash convert \
#        --to sri --hash-algo sha256 <base32-hash>
# 3. Set `pinnedNixpkgsRev` and `pinnedNixpkgsSha256` below to the new
#    values.
# 4. Record the new commit, source branch, and review date here and in
#    `docs/security-toolchain-inventory-2026-11.md`.
# 5. Confirm the shell still builds: `nix-shell --pure shell.nix --run
#    "cargo --version"`.
let
  pinnedNixpkgsRev = "41992211735edd8f46bb3d443abf0bffcfd71870";
  # NAR hash of the unpacked tarball (not a raw tar.gz sha256sum),
  # computed with `nix-prefetch-url --unpack` and verified against the
  # `NAR hash mismatch ... expected ... but got` message from
  # `nix-instantiate` in an isolated nixos/nix container; see the
  # 2026-11-11 addendum in docs/security-toolchain-inventory-2026-11.md.
  pinnedNixpkgsSha256 = "sha256-pXSKITDBL5U5Z2fCZWXzdI2rHWlnvD7N5K6fvrlAY50=";
  pkgs = import (builtins.fetchTarball {
    url =
      "https://github.com/NixOS/nixpkgs/archive/${pinnedNixpkgsRev}.tar.gz";
    sha256 = pinnedNixpkgsSha256;
  }) { };
in pkgs.mkShell {
  buildInputs = with pkgs; [
    rustc
    cargo

    libGL
    xorg.libX11
    xorg.libXi
    libxkbcommon
  ];

  shellHook = ''
    export LD_LIBRARY_PATH="$LD_LIBRARY_PATH:${
      with pkgs;
      pkgs.lib.makeLibraryPath [ libGL xorg.libX11 xorg.libXi libxkbcommon ]
    }"
  '';
}
