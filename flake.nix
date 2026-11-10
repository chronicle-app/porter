{
  description = "Porter dev shell: Node 22 and an S3-compatible server for conformance tests";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    devshell.url = "github:numtide/devshell";
    devshell.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      self,
      nixpkgs,
      devshell,
    }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems =
        f:
        nixpkgs.lib.genAttrs systems (
          system:
          f (
            import nixpkgs {
              inherit system;
              overlays = [ devshell.overlays.default ];
            }
          )
        );
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.devshell.mkShell {
          # Not "porter": devshell puts an entrypoint named after the shell on
          # PATH, which would hide the porter command below.
          name = "porter-dev";
          motd = ''
            {bold}porter-dev{reset}: blob store and RASL server for Chronicle
            $(type -p menu &>/dev/null && menu)
          '';
          packages = with pkgs; [
            # package.json engines is >=22.13.0, matching Chronicle and Vestry.
            nodejs_22
            # S3-compatible server for the conformance suite. Garage is Linux-only
            # in nixpkgs and MinIO is archived; versitygw builds everywhere.
            versitygw
          ];
          env = [
            {
              # Chronicle's dev profile: porter here uses "Chronicle Dev/porter",
              # never the real data an installed Chronicle uses.
              name = "CHRONICLE_PROFILE";
              value = "dev";
            }
          ];
          commands = [
            {
              category = "run";
              name = "porter";
              help = "Build, then run porter from this checkout (dev profile)";
              command = ''npm run --prefix "$PRJ_ROOT" build --silent && node "$PRJ_ROOT/bin/porter.js" "$@"'';
            }
            {
              category = "develop";
              name = "setup";
              help = "Install npm dependencies";
              command = "npm ci";
            }
            {
              category = "develop";
              name = "check";
              help = "Typecheck and run the test suite";
              command = "npm run typecheck && npm test";
            }
            {
              category = "develop";
              name = "build";
              help = "Compile TypeScript to dist/";
              command = "npm run build";
            }
          ];
        };
      });
    };
}
