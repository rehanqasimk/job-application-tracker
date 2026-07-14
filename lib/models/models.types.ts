export interface JobEvent {
  type: string;
  summary: string;
  at: string;
}

export interface JobApplication {
  _id: string;
  company: string;
  position: string;
  location?: string;
  status: string;
  notes?: string;
  salary?: string;
  jobUrl?: string;
  order: number;
  columnId?: string;
  tags?: string[];
  description?: string;
  // Outlier "last 3 events" preview, denormalized on the job doc (Task 4).
  recentEvents?: JobEvent[];
}

export interface Column {
  _id: string;
  name: string;
  order: number;
  jobApplications: JobApplication[];
}

export interface Board {
  _id: string;
  name: string;
  columns: Column[];
}
