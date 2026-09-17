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
export class InstanceStore {
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS instances (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, run_id TEXT);
      CREATE TABLE IF NOT EXISTS github_effects (id TEXT PRIMARY KEY, payload TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS issue_projects (issue_id TEXT NOT NULL, project_id TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(issue_id,project_id));
      CREATE TABLE IF NOT EXISTS project_choices (issue_id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS github_attention (id INTEGER PRIMARY KEY, project TEXT NOT NULL, message TEXT NOT NULL);`);
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
  chooseProject(id: string, projectId: string): void {
    if (this.get(id).runId)
      throw new Error("Project choice must precede the lifecycle run");
    const row = this.db
      .prepare(
        "SELECT snapshot FROM issue_projects WHERE issue_id=? AND project_id=?",
      )
      .get(id, projectId);
    if (!row) throw new Error("Issue is not in that bound project");
    this.db
      .prepare("INSERT OR REPLACE INTO project_choices VALUES (?,?)")
      .run(id, projectId);
    this.update(JSON.parse(String(row["snapshot"])) as IssueSnapshot);
  }
  discover(issue: IssueSnapshot): void {
    this.membership(issue);
    this.db
      .prepare("INSERT OR IGNORE INTO instances VALUES (?,?,NULL)")
      .run(issue.id, JSON.stringify(issue));
  }
  get(id: string): Instance {
    const row = this.db.prepare("SELECT * FROM instances WHERE id=?").get(id);
    if (!row) throw new Error(`Unknown instance ${id}`);
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
    this.db.prepare("UPDATE instances SET run_id=? WHERE id=?").run(runId, id);
  }
  update(issue: IssueSnapshot): void {
    this.db
      .prepare("UPDATE instances SET snapshot=? WHERE id=?")
      .run(JSON.stringify(issue), issue.id);
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
  attention(project: string, message: string): void {
    this.db
      .prepare("INSERT INTO github_attention(project,message) VALUES (?,?)")
      .run(project, message);
  }
}
