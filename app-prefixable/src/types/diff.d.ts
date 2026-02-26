declare module "diff" {
  export interface Hunk {
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    lines: string[]
  }

  export interface ParsedDiff {
    index?: string
    oldFileName?: string
    newFileName?: string
    oldHeader?: string
    newHeader?: string
    hunks: Hunk[]
  }

  export function parsePatch(patch: string): ParsedDiff[]
}
