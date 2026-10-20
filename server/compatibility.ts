// These daemon series share the reviewed PID lock and local credential lifecycle.
export function daemonCompatibilityError(version: unknown, backgroundWorkspaces: boolean): string | null {
  const match = typeof version === "string" ? /^0\.(11|12)\.(0|[1-9]\d*)$/.exec(version) : null;
  const patch = match ? Number(match[2]) : NaN;
  if (!match || !Number.isSafeInteger(patch) || (match[1] === "11" && patch < 4)) {
    return "This daemon version is not supported. Use stable Paseo 0.11.4 through 0.12.x.";
  }
  if (match[1] === "12" && !backgroundWorkspaces) {
    return "This daemon does not advertise background workspace support. Update Paseo before continuing.";
  }
  return null;
}
