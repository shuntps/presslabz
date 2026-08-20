import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import subsetFont from 'subset-font'
import { compress } from 'wawoff2'

/**
 * Rebuilds the three font files this product ships.
 *
 * Provenance you can check rather than a sentence asking to be believed: each
 * family is pinned to an upstream commit or release tag, the bytes that come
 * back are checked against a digest recorded here, and the subsetting is this
 * script rather than a command somebody ran once on a laptop. Run it and the
 * files in `src/fonts` are reproduced.
 *
 * The characters are the ones the product actually draws: Latin, the French
 * diacritics, typographic punctuation, and the handful of arrows and marks the
 * interface uses as icons. A reader whose *content* needs a letter outside
 * this set gets it from their system's serif — visible, and the price of
 * shipping 90 KB instead of 1.2 MB.
 *
 * **Source Serif is renamed on the way through, and that is a licence
 * requirement, not a preference.** Its copyright reserves the name "Source",
 * and the OFL forbids a Modified Version from using a Reserved Font Name. A
 * subset is a modified version. What ships is therefore our own name over
 * Adobe's unmodified outlines, which is exactly what the licence asks for.
 */

const FONTS_DIR = fileURLToPath(new URL('../src/fonts/', import.meta.url))

/**
 * Every codepoint the interface and the default theme can draw.
 *
 * Written out rather than expressed as ranges so that the file itself is the
 * list — a range hides what it includes, and this is the thing a reviewer
 * needs to see.
 */
const CHARACTERS = [
  // ASCII, printable.
  ' !"#$%&\'()*+,-./0123456789:;<=>?@',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`',
  'abcdefghijklmnopqrstuvwxyz{|}~',
  // Latin-1 letters the two shipped languages need, plus the ligatures and
  // capitals French typography asks for.
  'ÀÂÄÆÇÈÉÊËÎÏÔÖÙÛÜŸŒàâäæçèéêëîïôöùûüÿœ',
  // Signs that appear in prose, prices and legal notices.
  '£¥§©«®°±¶·»×÷€№™‰†‡•…‹›–—‘’“”',
  // The interface's own marks: block controls, states, the theme toggle.
  '←↑→↓↔⌃⌄⌘■□▪▫◆◇●✓✕⟷',
].join('')

/**
 * What each family is, where it came from, and what it is allowed to be
 * called here.
 *
 * `sha256` is of the *upstream* file, before anything is done to it. A
 * mismatch means the pin moved under us, which is the one thing a URL cannot
 * promise on its own.
 */
const FAMILIES = [
  {
    file: 'Archivo.woff2',
    // No tags upstream; pinned to the commit that carries version 2.001.
    url: 'https://raw.githubusercontent.com/Omnibus-Type/Archivo/b5d63988ce19d044d3e10362de730af00526b672/fonts/variable/Archivo%5Bwdth,wght%5D.ttf',
    sha256: '664bbeb10522dac35c174a3860aaecad7b1ad3a0fc8b0d26888e26c824ec556d',
    rename: null,
  },
  {
    file: 'JetBrainsMono.woff2',
    url: 'https://raw.githubusercontent.com/JetBrains/JetBrainsMono/v2.304/fonts/variable/JetBrainsMono%5Bwght%5D.ttf',
    sha256: '662a196d58f1183bf2d77428b6d5283fe3f45161ab021bea4036bc98e5cac016',
    rename: null,
  },
  {
    file: 'PressLabzSerif.woff2',
    url: 'https://raw.githubusercontent.com/adobe-fonts/source-serif/4.004R/VAR/SourceSerif4Variable-Roman.ttf',
    sha256: '38e35c59990b5a39ffb9fb841dfa6f5d2a80ce2c5ea004c3e433b1efd83ebbd0',
    // Required by the OFL: "Source" is a Reserved Font Name and this is a
    // Modified Version. See NOTICE.md.
    rename: { family: 'PressLabz Serif', postScript: 'PressLabzSerif-Regular' },
  },
]

/** Name IDs that carry a family name a browser or an OS will show. */
const FAMILY_NAME_IDS = new Set([1, 3, 4, 16])
const POSTSCRIPT_NAME_ID = 6

/**
 * Rewrites the `name` table of an sfnt, leaving every other table untouched.
 *
 * The table changes length, so the directory offsets after it move; those are
 * recomputed here along with the checksums. Done by hand rather than through a
 * font library because a library that does not understand `fvar`, `gvar` and
 * `STAT` will happily drop them, and what makes these files small *and*
 * variable is exactly those tables.
 */
function renameSfnt(sfnt, { family, postScript }) {
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength)
  const numTables = view.getUint16(4)

  const directory = []
  for (let index = 0; index < numTables; index += 1) {
    const record = 12 + index * 16
    directory.push({
      tag: String.fromCharCode(...sfnt.subarray(record, record + 4)),
      checksum: view.getUint32(record + 4),
      offset: view.getUint32(record + 8),
      length: view.getUint32(record + 12),
    })
  }

  const nameEntry = directory.find((table) => table.tag === 'name')
  if (!nameEntry) throw new Error('no name table')

  const table = sfnt.subarray(nameEntry.offset, nameEntry.offset + nameEntry.length)
  const tableView = new DataView(table.buffer, table.byteOffset, table.byteLength)
  const count = tableView.getUint16(2)
  const stringOffset = tableView.getUint16(4)

  /** Every record, with its string decoded so it can be replaced by name. */
  const records = []
  for (let index = 0; index < count; index += 1) {
    const record = 6 + index * 12
    const platformId = tableView.getUint16(record)
    const encodingId = tableView.getUint16(record + 2)
    const languageId = tableView.getUint16(record + 4)
    const nameId = tableView.getUint16(record + 6)
    const length = tableView.getUint16(record + 8)
    const offset = tableView.getUint16(record + 10)
    const raw = table.subarray(stringOffset + offset, stringOffset + offset + length)

    const utf16 = platformId === 3 || (platformId === 0 && encodingId !== 0)
    const value = utf16 ? new TextDecoder('utf-16be').decode(raw) : raw.toString('latin1')

    let next = value
    if (FAMILY_NAME_IDS.has(nameId)) next = family
    if (nameId === POSTSCRIPT_NAME_ID) next = postScript
    // The unique identifier must stay unique, and must stop claiming to be
    // somebody else's font.
    if (nameId === 3) next = `${family}; subset for PressLabz`

    records.push({ platformId, encodingId, languageId, nameId, value: next, utf16 })
  }

  const encoded = records.map((record) =>
    record.utf16
      ? Buffer.from(new Uint8Array(Buffer.from(record.value, 'utf16le').map((_, i, all) =>
          i % 2 === 0 ? all[i + 1] : all[i - 1],
        )))
      : Buffer.from(record.value, 'latin1'),
  )

  const header = Buffer.alloc(6 + records.length * 12)
  header.writeUInt16BE(0, 0)
  header.writeUInt16BE(records.length, 2)
  header.writeUInt16BE(header.length, 4)

  let cursor = 0
  records.forEach((record, index) => {
    const at = 6 + index * 12
    header.writeUInt16BE(record.platformId, at)
    header.writeUInt16BE(record.encodingId, at + 2)
    header.writeUInt16BE(record.languageId, at + 4)
    header.writeUInt16BE(record.nameId, at + 6)
    header.writeUInt16BE(encoded[index].length, at + 8)
    header.writeUInt16BE(cursor, at + 10)
    cursor += encoded[index].length
  })

  const rebuilt = Buffer.concat([header, ...encoded])
  return rebuildSfnt(sfnt, directory, 'name', rebuilt)
}

/** Four-byte alignment, as the format requires between tables. */
const padded = (length) => (length + 3) & ~3

function tableChecksum(buffer) {
  let sum = 0
  const aligned = Buffer.concat([buffer, Buffer.alloc(padded(buffer.length) - buffer.length)])
  for (let at = 0; at < aligned.length; at += 4) sum = (sum + aligned.readUInt32BE(at)) >>> 0
  return sum
}

/** Writes a new sfnt with one table replaced, recomputing what that moves. */
function rebuildSfnt(sfnt, directory, tag, replacement) {
  const tables = directory
    .map((entry) => ({
      ...entry,
      data: entry.tag === tag ? replacement : sfnt.subarray(entry.offset, entry.offset + entry.length),
    }))
    .sort((a, b) => (a.tag < b.tag ? -1 : 1))

  const header = Buffer.alloc(12 + tables.length * 16)
  header.writeUInt32BE(sfnt.readUInt32BE(0), 0)
  header.writeUInt16BE(tables.length, 4)
  // searchRange, entrySelector and rangeShift, as the specification defines
  // them: a browser does not read these, and a validator does.
  const highest = 2 ** Math.floor(Math.log2(tables.length))
  header.writeUInt16BE(highest * 16, 6)
  header.writeUInt16BE(Math.log2(highest), 8)
  header.writeUInt16BE(tables.length * 16 - highest * 16, 10)

  let offset = header.length
  const body = []

  tables.forEach((table, index) => {
    const at = 12 + index * 16
    header.write(table.tag, at, 4, 'latin1')
    header.writeUInt32BE(tableChecksum(table.data), at + 4)
    header.writeUInt32BE(offset, at + 8)
    header.writeUInt32BE(table.data.length, at + 12)

    const chunk = Buffer.concat([
      table.data,
      Buffer.alloc(padded(table.data.length) - table.data.length),
    ])
    body.push(chunk)
    offset += chunk.length
  })

  const rebuilt = Buffer.concat([header, ...body])

  /*
   * head.checkSumAdjustment is the whole file's checksum, which cannot be
   * computed until the file exists — so it is zeroed, the sum is taken, and
   * the difference written back.
   */
  const head = tables.find((table) => table.tag === 'head')
  if (head) {
    const headOffset = rebuilt.indexOf(head.data.subarray(0, 12))
    rebuilt.writeUInt32BE(0, headOffset + 8)
    const whole = tableChecksum(rebuilt)
    rebuilt.writeUInt32BE((0xb1b0afba - whole) >>> 0, headOffset + 8)
  }

  return rebuilt
}

async function build() {
  for (const family of FAMILIES) {
    const response = await fetch(family.url)
    if (!response.ok) throw new Error(`${family.url} answered ${response.status}`)

    const upstream = Buffer.from(await response.arrayBuffer())
    const digest = createHash('sha256').update(upstream).digest('hex')

    if (family.sha256 && digest !== family.sha256) {
      throw new Error(
        `${family.file}: upstream is not what this script was pinned to.\n` +
          `  expected ${family.sha256}\n  received ${digest}`,
      )
    }

    const subset = await subsetFont(upstream, CHARACTERS, { targetFormat: 'sfnt' })
    const named = family.rename ? renameSfnt(subset, family.rename) : subset
    const woff2 = Buffer.from(await compress(named))

    await writeFile(`${FONTS_DIR}${family.file}`, woff2)
    console.warn(
      `${family.file}: ${(woff2.length / 1024).toFixed(1)} KB` +
        `  (upstream sha256 ${digest.slice(0, 16)}…)`,
    )
  }
}

await build()

// Read back what was written, so a run that produced something unreadable
// says so here rather than in a browser.
for (const family of FAMILIES) {
  const written = await readFile(`${FONTS_DIR}${family.file}`)
  if (written.subarray(0, 4).toString('latin1') !== 'wOF2') {
    throw new Error(`${family.file} is not a woff2 file`)
  }
}
