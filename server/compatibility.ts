// Check the stable minimum and required capabilities, not a minor-version ceiling.
export function daemonCompatibilityError(version: unknown, backgroundWorkspaces: boolean): string | null {
  const match = typeof version === "string" ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version) : null;
  const [major, minor, patch] = match ? match.slice(1).map(Number) : [];
  if (!match || ![major, minor, patch].every(Number.isSafeInteger) || major === 0 && (minor < 11 || minor === 11 && patch < 4)) {
    return "This daemon version is not supported. Use stable Paseo 0.11.4 or later.";
  }
  if ((major > 0 || minor >= 12) && !backgroundWorkspaces) {
    return "This daemon does not advertise background workspace support. Update Paseo before continuing.";
  }
  return null;
}
