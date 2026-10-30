export function tasksPhrase(argument: string): string {
  if (argument === "today") return "Show today's tasks";
  if (argument === "overdue") return "Which tasks are overdue?";
  return "Show my pending tasks";
}
