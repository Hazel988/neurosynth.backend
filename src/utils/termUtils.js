// Lightweight stemmer to match synonyms and morphological variants (e.g. emotion / emotional / emotions)
export function getStem(word) {
  if (!word || word.length < 3) return word.toLowerCase()
  let s = word.toLowerCase().trim()

  // Irregular forms mapping
  const irregulars = {
    memories: 'memory',
    stimuli: 'stimulus',
    affective: 'affect',
    affect: 'affect',
    cognitive: 'cognit',
    cognition: 'cognit',
    behavioral: 'behavior',
    behavior: 'behavior',
    behavioural: 'behavior',
    behaviour: 'behavior',
    neural: 'neuro',
    neuron: 'neuro',
    neuronal: 'neuro',
    auditory: 'audit',
    visual: 'visu',
    visuospatial: 'visu'
  }
  if (irregulars[s]) return irregulars[s]

  // Common suffix stripping
  const suffixes = [
    'tional', 'tions', 'tion',
    'ities', 'ity',
    'ive', 'ively',
    'ment', 'ments',
    'able', 'ably',
    'ally', 'al',
    'ing', 'ed',
    'ies', 'es', 's'
  ]

  for (const suf of suffixes) {
    if (s.endsWith(suf) && s.length - suf.length >= 3) {
      s = s.slice(0, -suf.length)
      break
    }
  }

  // Handle repeated consonants or y/i endings
  if (s.endsWith('i')) s = s.slice(0, -1) + 'y'
  return s
}

/**
 * Find matching terms or morphological variants
 * @param {string} input - User query input
 * @param {string[]} allTerms - List of available terms
 * @param {number} maxResults - Max items to return
 */
export function findTermMatches(input, allTerms, maxResults = 50) {
  if (!input || !input.trim()) return []
  const q = input.trim().toLowerCase()
  const qStem = getStem(q)

  const exact = []
  const prefix = []
  const variants = []
  const contains = []

  for (const term of allTerms) {
    const tLower = term.toLowerCase()

    if (tLower === q) {
      exact.push({ term, matchType: 'exact' })
      continue
    }

    if (tLower.startsWith(q)) {
      prefix.push({ term, matchType: 'prefix' })
      continue
    }

    // Check stem or variant forms (e.g. emotion -> emotional)
    const words = tLower.split(/\s+/)
    let isVariant = false
    for (const w of words) {
      const wStem = getStem(w)
      if (wStem === qStem || (wStem.length >= 3 && qStem.length >= 3 && (wStem.startsWith(qStem) || qStem.startsWith(wStem)))) {
        variants.push({ term, matchType: 'variant', variantWord: w })
        isVariant = true
        break
      }
    }
    if (isVariant) continue

    if (tLower.includes(q)) {
      contains.push({ term, matchType: 'contains' })
    }
  }

  const combined = [...exact, ...prefix, ...variants, ...contains]
  return combined.slice(0, maxResults)
}

