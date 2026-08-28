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
  // Capitalised contractions. CAPRUN allows apostrophes, so "I've" matched as a
  // one-word organisation mid-sentence and every cover letter was rejected.
  "i've", "i'm", "i'd", "i'll", "we've", "we're", "we'd", "we'll", "you're",
  "you've", "it's", "that's", "there's", "here's", "don't", "can't", "won't",
  "isn't", "aren't", "wasn't", "haven't", "hasn't", "didn't", "doesn't",
  // months
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  // ubiquitous tech nouns that are not employers
  "python", "typescript", "javascript", "java", "go", "rust", "ruby", "swift", "kotlin",
  "react", "node", "docker", "kubernetes", "postgres", "postgresql", "redis", "kafka",
  "aws", "gcp", "azure", "linux", "git", "github", "api", "apis", "sql", "graphql",
  "ci", "cd", "ml", "ai", "llm", "sdk", "http", "rest", "grpc", "json",
  // Subordinating conjunctions and pronouns that open a clause. A capitalised
  // "If", "When", or "While" lands inside a capital run and is not a name.
  "if", "when", "while", "although", "because", "since", "though", "unless", "whether", "after", "before", "during", "it", "its", "his", "her", "from", "by",
]);
