# Lazy Judge
An online timed judge platform for algorithmic problems.

[lazyjudge.com](https://lazyjudge.com)

## Design

![Lazy Judge Architecture](https://github.com/Scenes7/Lazy-Judge/blob/main/architecture.png)

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | TypeScript, React, Next.js |
| **CDN / DNS** | Cloudflare |
| **Hosting** | AWS Amplify (frontend) · AWS EC2 (API) |
| **API Gateway** | Go · Gin · gorilla/websocket · Nginx |
| **Judge Backend** | AWS Lambda (Python) · Docker on ECR |
| **Storage** | Amazon S3 (problems & test cases) · DynamoDB (submissions) |