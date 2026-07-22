{
  description = "fennel-ls-rs — Fennel language server (Rust)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            # Rust toolchain management
            rustup
            # For tree-sitter-fennel grammar regeneration
            nodejs
            tree-sitter
          ];

          shellHook = ''
            echo "fennel-ls-rs dev shell"
            echo "  cargo build / cargo test   — LSP crate"
            echo "  cd tree-sitter-fennel"
            echo "  npm install && tree-sitter generate   — regenerate parser.c after grammar changes"
          '';
        };
      });
    };
}
