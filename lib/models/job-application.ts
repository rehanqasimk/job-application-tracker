import mongoose, { Schema, Document } from "mongoose";

/** Bounded "last 3 events" preview embedded on the job (Outlier Pattern). */
export interface IRecentEvent {
  type: string;
  summary: string;
  at: Date;
}

export interface IJobApplication extends Document {
  company: string;
  position: string;
  location?: string;
  status: string;
  columnId: mongoose.Types.ObjectId;
  boardId: mongoose.Types.ObjectId;
  userId: string;
  order: number;
  notes?: string;
  salary?: string;
  jobUrl?: string;
  appliedDate?: Date;
  tags?: string[];
  description?: string;
  recentEvents: IRecentEvent[];
  createdAt: Date;
  updatedAt: Date;
}

// Sub-schema for the embedded preview entries. `_id: false` — these are inline
// snapshots, not standalone documents.
const RecentEventSchema = new Schema<IRecentEvent>(
  {
    type: { type: String, required: true },
    summary: { type: String, required: true },
    at: { type: Date, required: true },
  },
  { _id: false }
);

const JobApplicationSchema = new Schema<IJobApplication>(
  {
    company: {
      type: String,
      required: true,
    },
    position: {
      type: String,
      required: true,
    },
    location: {
      type: String,
    },
    status: {
      type: String,
      required: true,
      default: "applied",
    },
    columnId: {
      type: Schema.Types.ObjectId,
      ref: "Column",
      required: true,
      index: true,
    },
    boardId: {
      type: Schema.Types.ObjectId,
      ref: "Board",
      required: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    order: {
      type: Number,
      required: true,
      default: 0,
    },
    notes: {
      type: String,
    },
    salary: {
      type: String,
    },
    jobUrl: {
      type: String,
    },
    appliedDate: {
      type: Date,
    },
    tags: [
      {
        type: String,
      },
    ],
    description: {
      type: String,
    },
    // Outlier Pattern: a CAPPED (last 3) denormalized preview of recent audit
    // events. Kept in sync via $push + $slice:-3 (see lib/audit.ts). Lets the
    // board render "recent activity" per card with NO join and NO unbounded
    // growth — the full history lives in the AuditLog collection.
    recentEvents: {
      type: [RecentEventSchema],
      default: [],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// The board renders each column's cards sorted by `order`. Every such read
// filters by columnId and sorts by order, so a compound index turns it into a
// single indexed range scan (no in-memory sort). Supports SC-002.
JobApplicationSchema.index({ columnId: 1, order: 1 });

// Virtual Relationship: full audit history on demand, WITHOUT storing it on the
// document. `.populate("auditLog")` pulls every event for this job (newest
// first) from the separate collection. Unpopulated, it costs nothing.
JobApplicationSchema.virtual("auditLog", {
  ref: "AuditLog",
  localField: "_id",
  foreignField: "jobId",
  options: { sort: { createdAt: -1 } },
});

export default mongoose.models.JobApplication ||
  mongoose.model<IJobApplication>("JobApplication", JobApplicationSchema);
