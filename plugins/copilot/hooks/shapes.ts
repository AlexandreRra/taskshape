// Task shapes: the same taxonomy as src/taskshape/shapes.py. Keep the two in step.
export type Shape = 'lookup' | 'routine' | 'demanding' | 'visual' | 'coupled' | 'review' | 'architecture'
export type Phase = 'work' | 'review'

export const SHAPES: Record<Shape, { capability: number; needs?: readonly string[] }> = {
  lookup: { capability: 0 },
  routine: { capability: 1 },
  demanding: { capability: 2 },
  visual: { capability: 2, needs: ['vision'] },
  coupled: { capability: 3 },
  review: { capability: 3 },
  architecture: { capability: 4 },
}

export const shapesFor = (phase: Phase): Shape[] =>
  phase === 'review' ? ['review', 'architecture'] : ['lookup', 'routine', 'demanding', 'visual', 'coupled', 'architecture']
