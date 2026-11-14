/* Coordinate conversion for the shared physical board in a combined preview. */
(function (root) {
  function reflectToolpath(source, { axis = 0, flipY = false, tileOffset = 0 } = {}) {
    let absolute = true;
    const coordinate = flipY ? "Y" : "X";
    const arcOffset = flipY ? "J" : "I";
    return source.split(/\r?\n/).map((line) => {
      const comment = /\([^)]*\)|;.*$/g;
      let code = line.replace(comment, (text) => " ".repeat(text.length)).toUpperCase();
      const modes = [...code.matchAll(/\bG\s*(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
      if (modes.includes(90)) absolute = true;
      if (modes.includes(91)) absolute = false;
      // Preserve comments exactly; only numeric G-code words are transformed.
      return line.replace(/\([^)]*\)|;.*$|\b([A-Z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/gi, (word, letter, raw) => {
        if (!letter) return word;
        const value = Number(raw);
        const axisWord = letter.toUpperCase();
        if (axisWord === coordinate) return `${letter}${(absolute ? 2 * axis - tileOffset - value : -value).toFixed(5)}`;
        if (axisWord === arcOffset) return `${letter}${(-value).toFixed(5)}`;
        // A reflection reverses the handedness of clockwise/counterclockwise arcs.
        if (axisWord === "G" && (value === 2 || value === 3)) return `G${value === 2 ? "03" : "02"}`;
        return word;
      });
    }).join("\n");
  }
  const helpers = { reflectToolpath };
  if (typeof module === "object" && module.exports) module.exports = helpers;
  else root.PCBPreview = helpers;
})(globalThis);
