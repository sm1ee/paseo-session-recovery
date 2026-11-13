// Check the stable minimum and required capabilities, not a minor-version ceiling.
// Prereleases are accepted only for cores newer than the newest checked stable
// minor (0.13): an older prerelease may predate the lifecycle this plugin needs.
const NEWEST_CHECKED_MINOR = 13;

export function daemonCompatibilityError(version: unknown, backgroundWorkspaces: boolean): string | null {
  const match = typeof version === "string"
    ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/.exec(version)
    : null;
  const [major, minor, patch] = match ? match.slice(1, 4).map(Number) : [];
  const prerelease = match?.[4] !== undefined;
  if (!match || ![major, minor, patch].every(Number.isSafeInteger) || major === 0 && (minor < 11 || minor === 11 && patch < 4) ||
    prerelease && major === 0 && minor <= NEWEST_CHECKED_MINOR) {
    return "This daemon version is not supported. Use stable Paseo 0.11.4 or later, or a 0.14+ prerelease.";
  }
  if ((major > 0 || minor >= 12) && !backgroundWorkspaces) {
    return "This daemon does not advertise background workspace support. Update Paseo before continuing.";
  }
  return null;
}
