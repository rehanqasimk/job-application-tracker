import mongoose, { Schema, Document } from "mongoose";

export type AuditEventType = "created" | "updated" | "moved" | "deleted";

/**
 * One document PER change to a job application. This is the unbounded full
 * history — it lives in its OWN collection so it never bloats the JobApplication
 * document (which would eventually hit Mongo's 16MB cap and slow every board
 * query that reads job docs). See REASONING.md (Task 4).
 */
export interface IAuditLog extends Document {
  jobId: mongoose.Types.ObjectId;
  userId: string; // tenant scope (= tenantId)
  type: AuditEventType;
  summary: string;
  changes?: Record<string, unknown>;
  createdAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    jobId: {
      type: Schema.Types.ObjectId,
      ref: "JobApplication",
      required: true,
    },
    userId: { type: String, required: true, index: true },
    type: { type: String, required: true },
    summary: { type: String, required: true },
    changes: { type: Schema.Types.Mixed },
  },
  // Events are immutable — only createdAt matters.
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Full-history reads are "this job's events, newest first" — one indexed scan.
AuditLogSchema.index({ jobId: 1, createdAt: -1 });

export default mongoose.models.AuditLog ||
  mongoose.model<IAuditLog>("AuditLog", AuditLogSchema);
