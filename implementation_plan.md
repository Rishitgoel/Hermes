# Implementation Plan - Restructuring Group Table Information

We will move the database table permission details out of the static group descriptions and present them dynamically as beautifully styled badges within the group detail view. This ensures the table list remains maintainable, dynamic, and visually readable.

## User Review Required

No major architectural decisions or open questions are pending. The schema and database migration will add `tables` to the Group model, and the frontend will display them as high-contrast chips using the design system.

## Proposed Changes

### Database Component

#### [MODIFY] [seed.ts](file:///d:/Bachatt/Atlas%202/backend/prisma/atlas/seed.ts)
- Clean up descriptions of the 6 mock groups to focus on high-level purpose (Growth, Retention, Lending, Customer Support, Credit Card, Marketing).
- Populate the `tables` attribute as a string array for each of the groups.
- Update `prisma.group.upsert` to update the `tables` attribute.

### Backend Component

#### [MODIFY] [group.controller.ts](file:///d:/Bachatt/Atlas%202/backend/src/controllers/group.controller.ts)
- Expose the `tables` array in both `getGroups` and `getGroupDetail` responses.

### Frontend Component

#### [MODIFY] [GroupDetail.tsx](file:///d:/Bachatt/Atlas%202/frontend/src/pages/GroupDetail.tsx)
- Update `GroupDetailData` interface to include `tables: string[]`.
- Add a new "Accessible Tables" section inside the group details card.
- Format the tables as clean, rounded monospaced badges with border accents matching the design system.

---

## Verification Plan

### Automated Tests
- Run database migrations: `npx prisma migrate dev --schema=prisma/atlas/schema.prisma --name add_group_tables`
- Run database seeding: `npm run prisma:seed`
- Compile and type-check the backend: `npm run build`
- Compile and type-check the frontend: `npm run build`

### Manual Verification
- View Group details page for each group and verify tables are listed cleanly.
- Verify descriptions no longer contain raw text lists of tables.
