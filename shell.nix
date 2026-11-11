# Pin review and update method: docs/security-toolchain-inventory-2026-11.md.
let
  pinnedNixpkgsRev = "41992211735edd8f46bb3d443abf0bffcfd71870";
  # fetchTarball checks the unpacked NAR hash, not the compressed tarball hash.
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
