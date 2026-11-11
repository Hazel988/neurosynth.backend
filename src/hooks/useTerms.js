import { useEffect, useState } from 'react'
import { API_BASE } from '../config/api'

const DEFAULT_TERMS = [
  'action', 'affect', 'affective', 'aging', 'altruism', 'alzheimer', 'amygdala', 'anxiety', 'aphasia', 'arousal',
  'attention', 'attentional', 'auditory', 'autism', 'awareness', 'basal ganglia', 'behavior', 'bipolar',
  'brain', 'broca', 'cerebellum', 'cingulate', 'cingulate cortex', 'cognition', 'cognitive', 'cognitive control',
  'conflict', 'consciousness', 'cortex', 'decision', 'decision making', 'default mode', 'default mode network',
  'depression', 'dmn', 'dopamine', 'dorsolateral', 'dlpfc', 'emotion', 'emotional', 'empathy', 'encoding',
  'episodic', 'episodic memory', 'error', 'executive', 'executive control', 'eye', 'eye movement', 'face',
  'faces', 'fear', 'fmri', 'frontal', 'frontoparietal', 'fusiform', 'fusiform gyrus', 'gait', 'gaze',
  'gustatory', 'hearing', 'hippocampus', 'inhibition', 'insula', 'insular', 'intelligence', 'intention',
  'interference', 'language', 'learning', 'lesion', 'limbic', 'linguistic', 'memory', 'mentalizing',
  'mind wandering', 'mood', 'morphometry', 'motivation', 'motor', 'motor cortex', 'movement', 'multisensory',
  'naming', 'navigation', 'neurodevelopmental', 'neuroimaging', 'neuroplasticity', 'nociception', 'novelty',
  'numerical', 'obsessive', 'occipital', 'olfactory', 'pain', 'painful', 'parahippocampal', 'parietal',
  'parkinson', 'perception', 'perceptual', 'phonological', 'planning', 'plasticity', 'pleasure', 'posterior cingulate',
  'prefrontal', 'prefrontal cortex', 'premotor', 'priming', 'processing', 'prosody', 'reading', 'reasoning',
  'recall', 'recognition', 'recollection', 'reinforcement', 'retrieval', 'reward', 'rhythm', 'risk',
  'saccade', 'salience', 'salience network', 'schizophrenia', 'semantic', 'sensorimotor', 'sensory',
  'sleep', 'social', 'social cognition', 'somatosensory', 'spatial', 'spatial attention', 'speech',
  'speech perception', 'speech production', 'stimulus', 'striatum', 'stroop', 'subcallosal', 'substance',
  'syntax', 'temporal', 'thalamus', 'theory of mind', 'threat', 'time', 'timing', 'tom', 'valence',
  'ventral', 'ventral striatum', 'ventromedial', 'vmpfc', 'vestibular', 'vision', 'visual', 'visual attention',
  'visuospatial', 'vocalization', 'voice', 'voice perception', 'working memory'
]

let cachedTerms = null
let fetchPromise = null

export function useTerms() {
  const [terms, setTerms] = useState(cachedTerms || DEFAULT_TERMS)
  const [loading, setLoading] = useState(!cachedTerms)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (cachedTerms) {
      setTerms(cachedTerms)
      setLoading(false)
      return
    }

    let alive = true
    if (!fetchPromise) {
      fetchPromise = fetch(`${API_BASE}/terms`)
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json()
          if (Array.isArray(data?.terms) && data.terms.length > 0) {
            cachedTerms = data.terms
          } else {
            cachedTerms = DEFAULT_TERMS
          }
          return cachedTerms
        })
        .catch((e) => {
          fetchPromise = null
          // Fall back to default terms on fetch error
          cachedTerms = DEFAULT_TERMS
          throw e
        })
    }

    fetchPromise
      .then((t) => {
        if (!alive) return
        setTerms(t)
        setLoading(false)
      })
      .catch((e) => {
        if (!alive) return
        setTerms(DEFAULT_TERMS)
        setErr(`Remote terms unavailable (${e?.message || e}); using standard vocabulary.`)
        setLoading(false)
      })

    return () => {
      alive = false
    }
  }, [])

  return { terms, loading, err }
}

