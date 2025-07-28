{ pkgs }: {
  deps = [
    pkgs.lsof
    pkgs.chromium
    pkgs.chromedriver
  ];
}