// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import type { DatabaseSync } from "node:sqlite";
import type { IssueSnapshot } from "./snapshot.js";
export interface Instance {
  id: string;
  issue: IssueSnapshot;
  runId: string | null;
}
/** What one intake attempt ran with, so the next one knows what changed. */
export interface IntakeAttempt {
  issueId: string;
  attempt: number;
  runId: string;
  commit: string;
  snapshot: string;
}
export interface ProjectChoiceQuestion {
  id: string;
  issueId: string;
  question: string;
  options: { label: string; projectId: string }[];
  answer: string | null;
}
export class InstanceStore {
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS instances (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, run_id TEXT);
      CREATE TABLE IF NOT EXISTS github_effects (id TEXT PRIMARY KEY, payload TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS issue_projects (issue_id TEXT NOT NULL, project_id TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(issue_id,project_id));
      CREATE TABLE IF NOT EXISTS project_choices (issue_id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_choice_questions (issue_id TEXT PRIMARY KEY, occurrence_id TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS issue_deliveries (issue_id TEXT NOT NULL, updated_at TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(issue_id,updated_at,snapshot));
      CREATE TABLE IF NOT EXISTS intake_attempts (issue_id TEXT PRIMARY KEY, attempt INTEGER NOT NULL, run_id TEXT NOT NULL, commit_id TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS github_attention (id INTEGER PRIMARY KEY, project TEXT NOT NULL, message TEXT NOT NULL);
      DELETE FROM github_attention WHERE id NOT IN (SELECT min(id) FROM github_attention GROUP BY project,message);
      CREATE UNIQUE INDEX IF NOT EXISTS github_attention_identity ON github_attention(project,message);`);
  }
  membership(issue: IssueSnapshot): void {
    this.db
      .prepare("INSERT OR REPLACE INTO issue_projects VALUES (?,?,?)")
      .run(issue.id, issue.project.id, JSON.stringify(issue));
  }
  ambiguous(id: string): boolean {
    return (
      Number(
        this.db
          .prepare(
            "SELECT count(*) AS count FROM issue_projects WHERE issue_id=?",
          )
          .get(id)?.["count"],
      ) > 1 &&
      !this.db.prepare("SELECT 1 FROM project_choices WHERE issue_id=?").get(id)
    );
  }
  projectChoice(id: string): ProjectChoiceQuestion | undefined {
    const memberships = this.db
      .prepare(
        "SELECT project_id,snapshot FROM issue_projects WHERE issue_id=? ORDER BY rowid",
      )
      .all(id);
    if (memberships.length < 2) return undefined;
    const occurrenceId = `project-choice:${id}`;
    this.db
      .prepare("INSERT OR IGNORE INTO project_choice_questions VALUES (?,?)")
      .run(id, occurrenceId);
    const selected = this.db
      .prepare("SELECT project_id FROM project_choices WHERE issue_id=?")
      .get(id);
    return {
      id: occurrenceId,
      issueId: id,
      question: "Which bound project owns this issue?",
      options: memberships.map((row) => {
        const issue = JSON.parse(String(row["snapshot"])) as IssueSnapshot;
        return {
          label: `${issue.project.owner}/${String(issue.project.number)}`,
          projectId: String(row["project_id"]),
        };
      }),
      answer: selected === undefined ? null : String(selected["project_id"]),
    };
  }
  membershipFor(id: string, projectId: string): IssueSnapshot | undefined {
    const row = this.db
      .prepare(
        "SELECT snapshot FROM issue_projects WHERE issue_id=? AND project_id=?",
      )
      .get(id, projectId);
    return row === undefined
      ? undefined
      : (JSON.parse(String(row["snapshot"])) as IssueSnapshot);
  }
  chooseProject(id: string, projectId: string): void {
    if (this.get(id).runId)
      throw new Error("Project choice must precede the lifecycle run");
    const issue = this.membershipFor(id, projectId);
    if (!issue) throw new Error("Issue is not in that bound project");
    this.db
      .prepare("INSERT OR REPLACE INTO project_choices VALUES (?,?)")
      .run(id, projectId);
    this.update(issue);
  }
  discover(issue: IssueSnapshot): void {
    this.membership(issue);
    this.db
      .prepare("INSERT OR IGNORE INTO instances VALUES (?,?,NULL)")
      .run(issue.id, JSON.stringify(issue));
  }
  get(id: string): Instance {
    const instance = this.find(id);
    if (!instance) throw new Error(`Unknown instance ${id}`);
    return instance;
  }
  find(id: string | null): Instance | undefined {
    const row = this.db.prepare("SELECT * FROM instances WHERE id=?").get(id);
    if (!row) return undefined;
    return {
      id: String(row["id"]),
      issue: JSON.parse(String(row["snapshot"])) as IssueSnapshot,
      runId: row["run_id"] === null ? null : String(row["run_id"]),
    };
  }
  list(): Instance[] {
    return this.db
      .prepare("SELECT id FROM instances ORDER BY rowid")
      .all()
      .map((row) => this.get(String(row["id"])));
  }
  attach(id: string, runId: string): void {
    const result = this.db
      .prepare(
        "UPDATE instances SET run_id=? WHERE id=? AND (run_id IS NULL OR run_id=?)",
      )
      .run(runId, id, runId);
    if (result.changes !== 1)
      throw new Error("Instance already belongs to a different lifecycle run");
  }
  update(issue: IssueSnapshot): void {
    this.db
      .prepare("UPDATE instances SET snapshot=? WHERE id=?")
      .run(JSON.stringify(issue), issue.id);
  }
  applyDelivery(issue: IssueSnapshot, updatedAt: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.db
        .prepare("INSERT OR IGNORE INTO issue_deliveries VALUES (?,?,?)")
        .run(issue.id, updatedAt, JSON.stringify(issue));
      if (inserted.changes > 0) this.update(issue);
      this.db.exec("COMMIT");
      return inserted.changes > 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  completed(key: string, payload: string): IssueSnapshot | undefined {
    const row = this.db
      .prepare("SELECT payload,snapshot FROM github_effects WHERE id=?")
      .get(key);
    if (!row) return undefined;
    if (row["payload"] !== payload)
      throw new Error("GitHub effect identity reused with different input");
    return JSON.parse(String(row["snapshot"])) as IssueSnapshot;
  }
  complete(key: string, payload: string, issue: IssueSnapshot): void {
    this.db
      .prepare("INSERT INTO github_effects VALUES (?,?,?)")
      .run(key, payload, JSON.stringify(issue));
  }
  intakeAttempt(issueId: string): IntakeAttempt | undefined {
    const row = this.db
      .prepare("SELECT * FROM intake_attempts WHERE issue_id=?")
      .get(issueId);
    return row === undefined
      ? undefined
      : {
          issueId,
          attempt: Number(row["attempt"]),
          runId: String(row["run_id"]),
          commit: String(row["commit_id"]),
          snapshot: String(row["snapshot"]),
        };
  }
  recordIntakeAttempt(attempt: IntakeAttempt): void {
    this.db
      .prepare("INSERT OR REPLACE INTO intake_attempts VALUES (?,?,?,?,?)")
      .run(
        attempt.issueId,
        attempt.attempt,
        attempt.runId,
        attempt.commit,
        attempt.snapshot,
      );
  }
  attention(project: string, message: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO github_attention(project,message) VALUES (?,?)",
      )
      .run(project, message);
  }
}
