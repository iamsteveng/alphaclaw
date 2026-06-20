## Goals 
Create a PostgreSQL database instance in Railway, on the next AlphaClaw deployment connect the GBrain to the database instance such that GBrain use it as the database. GBrain doesn't use pglite any more. 
Refer to https://github.com/garrytan/gbrain for detailed usage of GBrain. 

## Verifications
All the behaviours below have to verified by scripts, but not by AI agent judgement. 
- PostgreSQL database is up and running
- Gbrain get, put, export functionality working with PostgreSQL database
- PostgreSQL database has the data ingested from GBrain persistent 
- AlphaClaw deployment and OpenClaw startup should be working no matter PostgreSQL database exists or not
- Scenarios of first time start or subsequent deployment of AlphaClaw should work seamlessly
- The conditions in local container setup are the same as that in Railway production instance, such that it will make sure deployment in Railway will succeed 

## Constraints
Do not change any codes in GBrain, we are user of GBrain.
Do not change the Railway deployment lifecycle.

## When you need human feedback
When there is something technically you cannot do, or a predefined test case is incorrect, write down the observations and suggested changes in a comment in the PR and tag me. 
