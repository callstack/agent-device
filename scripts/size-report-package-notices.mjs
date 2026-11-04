// The THIRD_PARTY_NOTICES.txt format: the build renders it and the pack gate reads it. It imports
// nothing, so the standalone size-report copy runs it without the repository's dependencies.

export const NO_BUNDLED_DEPENDENCIES_NOTICE = 'No third-party dependencies are bundled.\n';

/**
 * The heading that opens a numbered license section. Every attribution is written before the first
 * one, so this line is also the boundary between the attributions and the license text.
 */
const LICENSE_SECTION_HEADING = /^\[(\d+)\]$/;
const AUTHOR_CLAUSE = '; Author: ';

/** The attribution block is one line per package, so manifest text that spans lines is joined. */
function singleLine(value) {
  return value.replaceAll(/\s+/g, ' ').trim();
}

function normalizeText(text) {
  return text.replaceAll('\r\n', '\n').trim();
}

/**
 * Renders one `name@version (license): [n], …; Author: …` line per dependency, sorted by code unit,
 * then each distinct text once under its `[n]` heading.
 */
export function renderLicenseNotices(dependencies) {
  if (dependencies.length === 0) return NO_BUNDLED_DEPENDENCIES_NOTICE;
  const texts = new Map();
  const reference = (text) => {
    const normalized = normalizeText(text);
    let id = texts.get(normalized);
    if (id === undefined) {
      id = texts.size + 1;
      texts.set(normalized, id);
    }
    return `[${id}]`;
  };
  const attributions = [...dependencies]
    .sort((left, right) => {
      const a = `${left.name}@${left.version}`;
      const b = `${right.name}@${right.version}`;
      return a < b ? -1 : a > b ? 1 : 0;
    })
    .map(
      (dependency) =>
        `${dependency.name}@${dependency.version} (${singleLine(dependency.license)}): ` +
        dependency.texts.map(reference).join(', ') +
        (dependency.author ? `${AUTHOR_CLAUSE}${singleLine(dependency.author)}` : ''),
    );
  const sections = Array.from(texts, ([text, id]) => `[${id}]\n${text}`);
  return `${[attributions.join('\n'), ...sections].join('\n\n')}\n`;
}

/**
 * The ids of the numbered sections that hold text. A section runs from its heading to the next
 * heading, so a license body with blank lines keeps that body. A heading-shaped line inside a body
 * only shortens its own section; it cannot fill an empty one.
 */
function readLicenseTextIds(lines) {
  const idsWithText = new Set();
  let openId;
  let seenText = false;
  for (const line of lines) {
    const heading = line.match(LICENSE_SECTION_HEADING);
    if (heading) {
      if (seenText) idsWithText.add(openId);
      openId = Number(heading[1]);
      seenText = false;
    } else if (openId !== undefined && line.trim()) {
      seenText = true;
    }
  }
  if (seenText) idsWithText.add(openId);
  return idsWithText;
}

/**
 * One attribution line, or undefined for any other line. The license field sits in the renderer's
 * parentheses, so a grouped SPDX expression nests inside it and the field ends at the first `):`.
 * References run to the author clause: an author holding `[n]` is metadata, not a reference.
 */
function readAttribution(line) {
  const attribution = line.match(/^(\S+@\S+ \((.+?)\)): ?(.*)$/);
  if (!attribution) return undefined;
  const references = attribution[3].split(AUTHOR_CLAUSE, 1)[0];
  return {
    label: attribution[1],
    references: [...references.matchAll(/\[(\d+)\]/g)].map((reference) => Number(reference[1])),
  };
}

/**
 * Reads attributions only from the block before the first section: sections hold upstream license
 * and NOTICE text verbatim, and prose there shaped like an attribution is not one.
 */
export function readLicenseNotices(contents) {
  const lines = contents.replaceAll('\r\n', '\n').split('\n');
  const firstSection = lines.findIndex((line) => LICENSE_SECTION_HEADING.test(line));
  const attributionLines = firstSection === -1 ? lines : lines.slice(0, firstSection);
  return {
    attributions: attributionLines
      .map(readAttribution)
      .filter((attribution) => attribution !== undefined),
    licenseTextIds: readLicenseTextIds(lines),
  };
}
