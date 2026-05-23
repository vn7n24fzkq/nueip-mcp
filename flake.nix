{
  description = "MCP server for nueip.com HR / attendance API";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";

  outputs = { self, nixpkgs }: let
    systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
    forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
  in {
    packages = forAllSystems (pkgs: {
      default = pkgs.buildNpmPackage {
        pname = "nueip-mcp";
        version = "0.1.0";
        src = ./.;
        npmDepsHash = "sha256-O5BeU0p2LaI6X6ngcTXLw1Ubw+r6280VOeh8A2s6Q4M=";
        buildPhase = ''
          npm run build
        '';
        installPhase = ''
          mkdir -p $out/dist $out/node_modules
          cp -r dist/* $out/dist/
          cp -r node_modules/* $out/node_modules/
          cp package.json $out/
        '';
      };
    });
  };
}
