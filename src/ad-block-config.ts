// Kept separate from the engine so the disabled path loads no filter code.
export function resolveAdBlock(value?: boolean, env = process.env): boolean {
  if (value !== undefined) {
    if (value !== true && value !== false) throw new TypeError("adBlock must be a boolean.");
    return value;
  }
  const setting = String(env.BETTERWRIGHT_AD_BLOCK || "").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(setting)) return false;
  if (["", "1", "true", "yes", "on"].includes(setting)) return true;
  throw new TypeError("BETTERWRIGHT_AD_BLOCK must be 1 or 0 (true or false).");
}

export function adBlockFromFlags(flags: Set<string>, env = process.env): boolean {
  if (flags.has("--ad-block") && flags.has("--no-ad-block")) {
    throw new TypeError("Use either --ad-block or --no-ad-block, not both.");
  }
  return resolveAdBlock(
    flags.has("--no-ad-block") ? false : flags.has("--ad-block") ? true : undefined,
    env,
  );
}
