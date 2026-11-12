# Tenancy test cases

Every ticket that adds a tenant-scoped route adds its own `<area>.cases.ts` here (e.g.
`datasets-read.cases.ts`). SP-042 glob-loads `*.cases.ts` and generates the cross-tenant matrix
from the route table; a route without a case fails that test. Add a file; never edit another
ticket's file.
