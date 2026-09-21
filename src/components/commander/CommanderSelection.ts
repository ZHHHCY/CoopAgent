export type CommanderWorkspaceSelection =
  | { kind: "levelPerk"; id: string }
  | { kind: "mastery"; category: number }
  | { kind: "prestige"; index: number }
  | { kind: "unit"; section: "roster" | "panel"; key: string }
  | { kind: "ability"; key: string }
  | null;
