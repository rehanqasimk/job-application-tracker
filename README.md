# Job Application Tracker

A full-stack job application tracking system built with Next.js, featuring a Kanban board interface for managing your job search. This project is part of a YouTube tutorial series where you'll learn how to build this application step by step.

## 🎥 Tutorial

This project accompanies a YouTube tutorial series. Follow along to learn how to build a complete job application tracker with authentication, drag-and-drop functionality, and real-time updates.

## 🛠️ Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript
- **UI Library**: React 19
- **Styling**: Tailwind CSS 4
- **Database**: MongoDB with Mongoose
- **Authentication**: Better Auth
- **Drag & Drop**: dnd-kit
- **UI Components**: Radix UI
- **Icons**: Lucide React

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ installed
- MongoDB database (local or cloud)
- npm, yarn, pnpm, or bun

### Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd job-application-tracker
```

2. Install dependencies:

```bash
npm install
```

3. Create a `.env.local` file in the root directory:

```env
MONGODB_URI=your_mongodb_connection_string
```

4. Run the development server:

```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000) in your browser.

## 📚 Tutorial: Building the Application

This section walks you through the key parts of the codebase and how they work together.

### 1. Database Setup (`lib/db.ts`)

The database connection uses a caching pattern to prevent multiple connections in development:

```typescript
// Connection is cached globally to prevent multiple connections
let cached: MongooseCache = global.mongoose || { conn: null, promise: null };
```

**Key Concepts:**

- Global caching prevents connection issues during hot reloads
- Connection reuse improves performance
- Error handling ensures graceful failures

### 2. Data Models (`lib/models/`)

The application uses three main models with relationships:

**Board Model** (`board.ts`):

- Represents a user's job hunt board
- Contains references to columns
- One board per user

**Column Model** (`column.ts`):

- Represents Kanban columns (Wish List, Applied, Interviewing, etc.)
- Contains references to job applications
- Has an `order` field for sorting

**JobApplication Model** (`job-application.ts`):

- Stores individual job application data
- References both column and board
- Includes fields like company, position, location, salary, tags, etc.

**Relationship Structure:**

```
Board (1) → (many) Columns → (many) JobApplications
```

### 3. Authentication (`lib/auth/auth.ts`)

Better Auth is configured with MongoDB adapter:

```typescript
export const auth = betterAuth({
  database: mongodbAdapter(db, { client }),
  emailAndPassword: { enabled: true },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          // Automatically create a board when user signs up
          await initializeUserBoard(user.id);
        },
      },
    },
  },
});
```

**Key Features:**

- Email/password authentication
- Automatic board creation on signup
- Session management with cookie caching

### 4. Server Actions (`lib/actions/job-applications.ts`)

Server actions handle all data mutations:

**createJobApplication:**

- Validates user session
- Verifies board and column ownership
- Calculates order for new job
- Updates column references

**updateJobApplication:**

- Handles moving jobs between columns
- Manages order updates with gap strategy (multiples of 100)
- Shifts other jobs when reordering

**deleteJobApplication:**

- Removes job from database
- Cleans up column references
- Revalidates cache

**Key Pattern:**

- All actions check authentication
- Ownership verification prevents unauthorized access
- `revalidatePath` ensures UI updates after mutations

### 5. Drag & Drop Implementation (`components/kanban-board.tsx`)

The Kanban board uses `@dnd-kit` for drag and drop:

**Components:**

- `DndContext`: Main drag and drop context
- `DroppableColumn`: Columns that accept dropped items
- `SortableJobCard`: Individual job cards that can be dragged
- `SortableContext`: Manages sortable items within columns

**Drag Flow:**

1. User starts dragging → `handleDragStart` sets active item
2. User drops → `handleDragEnd` calculates new position
3. Position calculation handles:
   - Dropping on column (appends to end)
   - Dropping on another job (inserts at that position)
   - Moving within same column (reorders)
4. `moveJob` hook updates database

**Key Features:**

- Visual feedback during drag (opacity, overlay)
- Collision detection with `closestCorners`
- Pointer sensor with activation distance to prevent accidental drags

### 6. Client State Management (`lib/hooks/useBoards.ts`)

Custom hook manages board state and provides mutation functions:

**Responsibilities:**

- Maintains local state synchronized with server
- Provides `moveJob` function for drag operations
- Optimistic updates for better UX

### 7. Dashboard Page (`app/dashboard/page.tsx`)

Server component that:

- Fetches user session
- Loads board data with populated relationships
- Uses React Suspense for loading states
- Redirects unauthenticated users

**Data Fetching Pattern:**

```typescript
const boardDoc = await Board.findOne({ userId, name: "Job Hunt" }).populate({
  path: "columns",
  populate: { path: "jobApplications" },
});
```

This single query loads the entire board structure efficiently.

### 8. Seeding the Database (`scripts/seed.ts`)

The seed script populates the database with sample job applications.

**Important Performance Note:**

For the seeding file, **strongly recommend using batch insert** (`await JobApplication.insertMany(applications)`) instead of creating jobs one by one. This reduces the number of round trips to MongoDB and significantly improves performance.

**Current Implementation:**
The current seed script creates jobs individually in a loop. While this works, it's not optimal for large datasets.

**Recommended Approach:**

```typescript
// Collect all job applications to create
const applicationsToCreate = [];

for (const [columnName, jobs] of Object.entries(jobsByColumn)) {
  const columnId = columnMap[columnName];
  if (!columnId) continue;

  for (let i = 0; i < jobs.length; i++) {
    const jobData = jobs[i];
    applicationsToCreate.push({
      company: jobData.company,
      position: jobData.position,
      // ... other fields
      columnId: columnId,
      boardId: board._id,
      userId: USER_ID,
      status: columnName.toLowerCase().replace(" ", "-"),
      order: i,
    });
  }
}

// Batch insert all applications at once
const createdApplications = await JobApplication.insertMany(
  applicationsToCreate
);

// Then update columns with references
for (const column of columns) {
  const columnApps = createdApplications.filter(
    (app) => app.columnId.toString() === column._id.toString()
  );
  column.jobApplications = columnApps.map((app) => app._id);
  await column.save();
}
```

**Benefits:**

- Single database round trip instead of N trips
- Faster execution (especially with many jobs)
- Atomic operation reduces partial failures
- Better for production seeding scenarios

### 9. User Board Initialization (`lib/init-user-board.ts`)

When a user signs up, a default board is created with predefined columns:

- Wish List
- Applied
- Interviewing
- Offer
- Rejected

This ensures every user starts with a functional board structure.

## 🎯 Key Learning Points

1. **Server Components vs Client Components**: Understanding when to use each
2. **Server Actions**: Type-safe mutations without API routes
3. **Database Relationships**: Mongoose populate for efficient queries
4. **Drag & Drop**: Implementing complex interactions with dnd-kit
5. **Authentication**: Better Auth integration with database hooks
6. **State Management**: Combining server state with client state
7. **Performance**: Batch operations for database efficiency

## 📝 Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run lint` - Run ESLint
- `npm run seed:jobs` - Seed database with sample jobs

## 🔐 Environment Variables

Required environment variables:

- `MONGODB_URI` - MongoDB connection string

## 📖 Project Structure

```
job-application-tracker/
├── app/                    # Next.js App Router pages
│   ├── api/               # API routes
│   ├── dashboard/         # Main dashboard page
│   └── sign-in/           # Authentication pages
├── components/            # React components
│   ├── ui/               # Reusable UI components
│   └── kanban-board.tsx  # Main Kanban component
├── lib/
│   ├── actions/          # Server actions
│   ├── auth/             # Authentication setup
│   ├── hooks/            # Custom React hooks
│   ├── models/           # Mongoose models
│   └── db.ts             # Database connection
└── scripts/              # Utility scripts
    └── seed.ts           # Database seeding
```

## 🎓 Next Steps

After completing this tutorial, consider:

- Adding job application status history
- Implementing search and filtering
- Adding email notifications for status changes
- Creating multiple boards per user
- Adding job application notes/attachments
- Implementing analytics dashboard

## 🏢 Multi-Tenant Local Development

This app routes tenants by **subdomain** (`user1.lvh.me:3000`) via edge middleware
(`proxy.ts`). See `specs/001-tenant-router-middleware/` for the full design.

### Setup

1. Copy env: `cp .env.example .env` and set `BETTER_AUTH_SECRET` (`openssl rand -base64 32`).
   Keep `ROOT_DOMAIN=lvh.me` and `NEXT_PUBLIC_BETTER_AUTH_URL=http://lvh.me:3000`.
2. `npm run dev`, then open **`http://lvh.me:3000`** (not `localhost`).
   `lvh.me` and `*.lvh.me` publicly resolve to `127.0.0.1`, so tenant subdomains
   work with no `/etc/hosts` edits.
3. Sign up at the apex → you're routed to `http://<your-slug>.lvh.me:3000/dashboard`.
4. Existing users (created before this feature): backfill slugs once with
   `npx tsx --env-file=.env scripts/backfill-subdomains.ts`.

### How it works (the edge-safe bit)

The middleware validates the session by reading better-auth's **signed
session-cache cookie** with `getCookieCache()` (Web Crypto, no DB) — so it never
imports `mongoose`/`bcrypt` and won't crash the Edge Runtime. It then injects a
trusted `x-tenant-id` header for Server Actions to scope by. Full behavior matrix
and verification steps: `specs/001-tenant-router-middleware/quickstart.md`.

> Production: set `ROOT_DOMAIN` to your apex and provision a `*.domain` wildcard
> DNS record + wildcard TLS cert. The code is unchanged — only env values differ.

## 📄 License

This project is created for educational purposes as part of a YouTube tutorial series.
