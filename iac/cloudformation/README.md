# AWS CloudFormation

CloudFormation is AWS's native IaC service. Unlike Terraform, state is fully managed by AWS — no state files to backup, no DynamoDB lock tables. Deep integration with every AWS service.

---

## Architecture

```mermaid
graph TD
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef red fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef purple fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef dark fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8
    classDef yellow fill:#f39c12,stroke:#d68910,color:#000,rx:8
    classDef k8s fill:#326ce5,stroke:#254ea8,color:#fff,rx:8
    classDef aws fill:#ff9900,stroke:#cc7a00,color:#000,rx:8
    TEMPLATE["CloudFormation Template (YAML or JSON)"]:::purple --> STACK["Stack unit of deployment"]:::green
    STACK --> CFN_SVC["CloudFormation Service AWS-managed state"]:::purple
    CFN_SVC --> RESOURCES["AWS Resources EC2, VPC, RDS, IAM..."]:::orange
    CFN_SVC --> EVENTS["Stack Events audit trail of every operation"]:::blue
    CFN_SVC --> OUTPUTS["Stack Outputs export values to other stacks"]:::teal

    CHANGESET["Change Set preview before apply"]:::blue --> STACK
```

---

## Stack Lifecycle

```mermaid
stateDiagram-v2
    [*] --> CREATE_IN_PROGRESS: CreateStack
    CREATE_IN_PROGRESS --> CREATE_COMPLETE: all resources created
    CREATE_IN_PROGRESS --> CREATE_FAILED: resource creation failed
    CREATE_FAILED --> DELETE_IN_PROGRESS: rollback triggered
    CREATE_COMPLETE --> UPDATE_IN_PROGRESS: UpdateStack or ExecuteChangeSet
    UPDATE_IN_PROGRESS --> UPDATE_COMPLETE: update succeeded
    UPDATE_IN_PROGRESS --> UPDATE_ROLLBACK_IN_PROGRESS: update failed
    UPDATE_ROLLBACK_IN_PROGRESS --> UPDATE_ROLLBACK_COMPLETE: rolled back
    CREATE_COMPLETE --> DELETE_IN_PROGRESS: DeleteStack
    DELETE_IN_PROGRESS --> [*]: DELETE_COMPLETE
```

**Rollback behavior:** If any resource fails during stack creation or update, CloudFormation automatically rolls back all changes in that operation. You see `ROLLBACK_COMPLETE` — all changes are undone.

---

## Template Structure

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Description: "My application stack"

Parameters:
  Environment:
    Type: String
    AllowedValues: [dev, staging, prod]
    Default: dev
  InstanceType:
    Type: String
    Default: t3.micro

Mappings:
  EnvToAMI:
    us-east-1:
      prod: ami-0abcdef1234567890
      dev:  ami-0fedcba9876543210

Conditions:
  IsProd: !Equals [!Ref Environment, prod]

Resources:
  WebServer:
    Type: AWS::EC2::Instance
    Properties:
      InstanceType: !Ref InstanceType
      ImageId: !FindInMap [EnvToAMI, !Ref AWS::Region, !Ref Environment]
      Tags:
        - Key: Environment
          Value: !Ref Environment

  # Conditional resource — only created in prod
  BackupBucket:
    Type: AWS::S3::Bucket
    Condition: IsProd
    Properties:
      BucketName: !Sub "${AWS::StackName}-backup-${AWS::AccountId}"

Outputs:
  WebServerPublicIP:
    Value: !GetAtt WebServer.PublicIp
    Export:
      Name: !Sub "${AWS::StackName}-WebServerIP"
```

**Intrinsic functions:**

| Function | Use |
|----------|-----|
| `!Ref` | Reference parameter or resource logical ID |
| `!GetAtt` | Get attribute of a resource (`!GetAtt MyBucket.Arn`) |
| `!Sub` | String substitution (`!Sub "arn:aws:s3:::${BucketName}/*"`) |
| `!FindInMap` | Look up value in Mappings |
| `!If` | Conditional value based on Condition |
| `!ImportValue` | Import output exported by another stack |
| `!Join` | Join strings (`!Join [":", [a, b, c]]` → `a:b:c`) |
| `!Select` | Select by index from a list |

---

## Change Sets

Change sets are CloudFormation's equivalent of `terraform plan` — preview what will happen before executing.

```mermaid
sequenceDiagram
    participant Dev as Developer/CI
    participant CFN as CloudFormation

    Dev->>CFN: CreateChangeSet (template + stack name)
    CFN->>CFN: Compute diff: current stack vs new template
    CFN-->>Dev: Change set created: list of + create, ~ update, - delete
    Dev->>Dev: Review changes (no resources touched yet)
    Dev->>CFN: ExecuteChangeSet
    CFN->>CFN: Apply changes to resources
    CFN-->>Dev: Stack UPDATE_COMPLETE
```

```bash
# Create a change set
aws cloudformation create-change-set \
  --stack-name my-stack \
  --template-body file://template.yaml \
  --change-set-name my-changes \
  --parameters ParameterKey=Environment,ParameterValue=prod

# Review the change set
aws cloudformation describe-change-set \
  --stack-name my-stack \
  --change-set-name my-changes

# Execute (actually apply)
aws cloudformation execute-change-set \
  --stack-name my-stack \
  --change-set-name my-changes
```

**Replacement vs Update:** Change sets show if a change requires replacement (resource destroyed and recreated) vs in-place update. A replacement of an RDS instance = data loss risk — the change set warns you.

---

## Nested Stacks

Break large templates into smaller reusable components using `AWS::CloudFormation::Stack`.

```mermaid
graph TD
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef red fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef purple fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef dark fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8
    classDef yellow fill:#f39c12,stroke:#d68910,color:#000,rx:8
    classDef k8s fill:#326ce5,stroke:#254ea8,color:#fff,rx:8
    classDef aws fill:#ff9900,stroke:#cc7a00,color:#000,rx:8
    ROOT["Root Stack my-app-prod"]:::blue --> VPC_STACK["Nested Stack: VPC AWS::CloudFormation::Stack"]:::purple
    ROOT --> ECS_STACK["Nested Stack: ECS Cluster AWS::CloudFormation::Stack"]:::orange
    ROOT --> RDS_STACK["Nested Stack: RDS AWS::CloudFormation::Stack"]:::purple

    VPC_STACK --> VPC_OUTPUTS["Outputs: VpcId, SubnetIds"]:::teal
    ECS_STACK --> ECS_INPUTS["Inputs: VpcId from VPC stack output"]:::teal
    RDS_STACK --> RDS_INPUTS["Inputs: SubnetIds from VPC stack output"]:::teal
```

```yaml
Resources:
  VPCStack:
    Type: AWS::CloudFormation::Stack
    Properties:
      TemplateURL: https://s3.amazonaws.com/my-bucket/vpc.yaml
      Parameters:
        CIDR: "10.0.0.0/16"

  ECSStack:
    Type: AWS::CloudFormation::Stack
    Properties:
      TemplateURL: https://s3.amazonaws.com/my-bucket/ecs.yaml
      Parameters:
        VpcId: !GetAtt VPCStack.Outputs.VpcId
        SubnetIds: !GetAtt VPCStack.Outputs.PrivateSubnets
```

**Cross-stack references (alternative to nested stacks):**

```yaml
# Stack A exports
Outputs:
  VpcId:
    Export:
      Name: my-app-prod-VpcId
    Value: !Ref VPC

# Stack B imports
Resources:
  Subnet:
    Properties:
      VpcId: !ImportValue my-app-prod-VpcId
```

Cross-stack references create a hard dependency — you cannot delete Stack A while Stack B imports its value.

---

## StackSets

Deploy a single CloudFormation template across **multiple AWS accounts and/or regions** from one operation.

```mermaid
graph TD
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef green fill:#2ecc71,stroke:#27ae60,color:#fff,rx:8
    classDef red fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef purple fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef teal fill:#1abc9c,stroke:#16a085,color:#fff,rx:8
    classDef dark fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8
    classDef yellow fill:#f39c12,stroke:#d68910,color:#000,rx:8
    classDef k8s fill:#326ce5,stroke:#254ea8,color:#fff,rx:8
    classDef aws fill:#ff9900,stroke:#cc7a00,color:#000,rx:8
    ADMIN["Administrator Account StackSet definition"]:::blue --> OU["AWS Organization OU or list of target accounts"]:::blue
    OU --> ACCOUNT_A["Account A (prod) us-east-1"]:::blue
    OU --> ACCOUNT_B["Account B (staging) us-east-1, eu-west-1"]:::blue
    OU --> ACCOUNT_C["Account C (dev) us-west-2"]:::blue

    ADMIN -->|"deployment options"| CONCURRENT["Concurrent deployments (faster)"]:::green
    ADMIN -->|"deployment options"| SERIAL["Serial deployments (safer for rollout)"]:::green
```

**Use cases:**
- Deploy security baselines (CloudTrail, GuardDuty, Config Rules) to all accounts
- Enforce IAM password policy across an organization
- Deploy shared networking (Transit Gateway attachments) to all accounts

```bash
aws cloudformation create-stack-set \
  --stack-set-name security-baseline \
  --template-body file://baseline.yaml \
  --capabilities CAPABILITY_NAMED_IAM

aws cloudformation create-stack-instances \
  --stack-set-name security-baseline \
  --deployment-targets OrganizationalUnitIds=["ou-xxxx-yyyyyyy"] \
  --regions us-east-1 eu-west-1
```

---

## Drift Detection

```bash
# Detect drift on a stack
aws cloudformation detect-stack-drift --stack-name my-stack

# Check drift status
aws cloudformation describe-stack-drift-detection-status \
  --stack-drift-detection-id <detection-id>

# See which resources drifted and how
aws cloudformation describe-stack-resource-drifts \
  --stack-name my-stack \
  --stack-resource-drift-status-filters MODIFIED DELETED
```

CFN drift detection compares the current live resource configuration against what the template defines. Drifted resources show `MODIFIED` or `DELETED`.

**Fix:** Remediate by either updating the template to match reality and re-deploying, or manually fixing the resource to match the template.

---

## Custom Resources

When CloudFormation doesn't natively support a resource type, use Custom Resources backed by Lambda.

```mermaid
sequenceDiagram
    participant CFN as CloudFormation
    participant Lambda as Lambda Function
    participant Resource as External Resource

    CFN->>Lambda: Invoke with Create/Update/Delete event + properties
    Lambda->>Resource: Create/update/delete the resource
    Resource-->>Lambda: Success/failure
    Lambda->>CFN: Send response to PreSignedUrl (SUCCESS or FAILED)
    CFN->>CFN: Continue stack operation based on response
```

```yaml
Resources:
  # Lambda function that handles the custom logic
  MyCustomResourceFunction:
    Type: AWS::Lambda::Function
    Properties:
      Handler: index.handler
      Runtime: python3.12
      Code:
        ZipFile: |
          import boto3, cfnresponse
          def handler(event, context):
            if event['RequestType'] == 'Create':
              # do something with event['ResourceProperties']
              cfnresponse.send(event, context, cfnresponse.SUCCESS, {'OutputKey': 'value'})

  # The custom resource that triggers the Lambda
  MyCustomResource:
    Type: Custom::MyResource
    Properties:
      ServiceToken: !GetAtt MyCustomResourceFunction.Arn
      MyParam: "some-value"

# Use the output
Outputs:
  CustomOutput:
    Value: !GetAtt MyCustomResource.OutputKey
```

**Common use cases:** DNS record creation in external providers, database schema initialization, Slack/PagerDuty notifications on stack events, resource types not yet in CloudFormation.
