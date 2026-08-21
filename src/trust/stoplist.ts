/**
 * Capitalised words that are not organisations.
 *
 * Without this, ordinary sentence-initial words and common proper-ish nouns are
 * flagged as invented employers and every draft is rejected — a validator that
 * rejects everything gets switched off, which is strictly worse than one that is
 * slightly permissive about "Python".
 */
export const STOPLIST = new Set([
  // sentence starters and connectives
  "i", "a", "an", "the", "and", "or", "but", "for", "with", "at", "in", "on", "to", "of", "as",
  "led", "built", "shipped", "drove", "owned", "managed", "designed", "created", "delivered",
  "reduced", "increased", "improved", "scaled", "launched", "migrated", "architected",
  "my", "our", "their", "this", "that", "these", "those", "we", "they",
  // months
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  // ubiquitous tech nouns that are not employers
  "python", "typescript", "javascript", "java", "go", "rust", "ruby", "swift", "kotlin",
  "react", "node", "docker", "kubernetes", "postgres", "postgresql", "redis", "kafka",
  "aws", "gcp", "azure", "linux", "git", "github", "api", "apis", "sql", "graphql",
  "ci", "cd", "ml", "ai", "llm", "sdk", "http", "rest", "grpc", "json",
]);
