// Shared by the tests. Deliberately written as code-point checks and not as the character
// class glance.ts uses, so a mistake in one is not repeated in the other.

/** True when a string still holds a control, bidi, invisible or malformed character. */
export function hasUnsafe(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0xad ||
      code === 0x61c ||
      code === 0x180e ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) ||
      // A lone surrogate. A well-formed pair is one code point to this loop, so it is not caught.
      (code >= 0xd800 && code <= 0xdfff) ||
      (code >= 0xfe00 && code <= 0xfe0f) ||
      code === 0xfeff ||
      (code >= 0xfff9 && code <= 0xfffb) ||
      // The tag block (text invisible to the eye) and the supplementary variation selectors.
      (code >= 0xe0000 && code <= 0xe007f) ||
      (code >= 0xe0100 && code <= 0xe01ef)
    ) {
      return true
    }
  }
  return false
}
