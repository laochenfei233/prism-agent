/**
 * CRC-32 (IEEE, reflected, polynomial `0xEDB88320`) over decompressed zip
 * bytes. fflate computes CRC internally but never exposes it, and a stored
 * entry's integrity can only be proven by comparing the decompressed bytes
 * against the central directory's recorded checksum.
 *
 * @module @prism/prism-transfer/crc32
 */

/** One row per byte value: the CRC of that byte followed by 24 zero bits. */
const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let value = 0; value < 256; value += 1) {
    let row = value
    for (let bit = 0; bit < 8; bit += 1) {
      row = (row & 1) !== 0 ? 0xedb88320 ^ (row >>> 1) : row >>> 1
    }
    table[value] = row
  }
  return table
})()

/** DataView over the table so masked row reads never index out of range. */
const TABLE_VIEW = new DataView(TABLE.buffer)

/** Incremental CRC-32 state, updated one bounded chunk at a time. */
export class Crc32 {
  private value = 0xffffffff

  /**
   * Fold one chunk into the running checksum.
   * @param chunk - the next decompressed bytes.
   */
  update(chunk: Uint8Array): void {
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    let state = this.value
    for (let index = 0; index < chunk.byteLength; index += 1) {
      state = TABLE_VIEW.getUint32(((state ^ view.getUint8(index)) & 0xff) * 4, true) ^ (state >>> 8)
    }
    this.value = state
  }

  /**
   * The finalized checksum.
   * @returns the unsigned CRC-32 of every folded chunk.
   */
  digest(): number {
    return (this.value ^ 0xffffffff) >>> 0
  }
}
