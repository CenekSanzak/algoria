import 'fast-text-encoding';

// JavaScriptCore needs encodeInto as well as encode/decode: the MPP SDK's
// Base64 decoder uses it. Honor UTF-16 read counts and avoid partial UTF-8 writes.
if (!TextEncoder.prototype.encodeInto) {
  TextEncoder.prototype.encodeInto = function (input, destination) {
    let read = 0, written = 0;
    for (const character of String(input)) {
      const bytes = this.encode(character);
      if (written + bytes.length > destination.length) break;
      destination.set(bytes, written);
      written += bytes.length;
      read += character.length;
    }
    return { read, written };
  };
}
