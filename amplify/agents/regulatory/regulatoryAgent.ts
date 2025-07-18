import * as cdk from 'aws-cdk-lib';
import { aws_s3 as s3 } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { aws_ec2 } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { bedrock as cdkLabsBedrock } from '@cdklabs/generative-ai-cdk-constructs';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';

interface BedrockAgentBuilderProps {
    description?: string;
    modelId?: string;
    environment?: string;
    instruction?: string;
    vpc: aws_ec2.Vpc;
    s3Bucket: s3.IBucket;
    s3Deployment: cdk.aws_s3_deployment.BucketDeployment;
    regulatoryAgentId?: string;
    regulatoryAgentAliasId?: string;
}

export function regulatoryAgentBuilder(scope: Construct, props: BedrockAgentBuilderProps) {
    const resourcePrefix = scope.node.tryGetContext('resourcePrefix') || 'regulatory';
    const environment = props.environment || scope.node.tryGetContext('environment') || 'dev';

    // Declare a UUID to append to resources to avoid naming collisions in Amplify
    const stackUUID = cdk.Names.uniqueResourceName(scope, { maxLength: 3 }).toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(-3)
    

    // Create IAM role for the Bedrock Agent
    const regulatoryAgentRole = new iam.Role(scope, 'RegulatoryAgentRole', {
        assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
        roleName: `BedrockAgentRole-${stackUUID}`,
        path: '/service-role/',
        description: 'Execution role for Bedrock Regulatory Agent'
    });

    // Add required permissions instead of using the non-existent managed policy
    regulatoryAgentRole.addToPolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock:InvokeModel',
                'bedrock:Retrieve',
                'bedrock:ListFoundationModels',
                'bedrock:ListCustomModels',
                'bedrock:InvokeAgent',
                'bedrock:RetrieveAgent'
            ],
            resources: [
                `arn:aws:bedrock:${cdk.Stack.of(scope).region}::foundation-model/*`,
                `arn:aws:bedrock:${cdk.Stack.of(scope).region}:${cdk.Stack.of(scope).account}:agent/*`,
                `arn:aws:bedrock:${cdk.Stack.of(scope).region}:${cdk.Stack.of(scope).account}:knowledge-base/*`
            ]
        })
    );

    // Add CloudWatch Logs permissions
    regulatoryAgentRole.addToPolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents'
            ],
            resources: [
                `arn:aws:logs:${cdk.Stack.of(scope).region}:${cdk.Stack.of(scope).account}:log-group:/aws/bedrock/*`
            ]
        })
    );

    // Add S3 access permissions
    props.s3Bucket.grantRead(regulatoryAgentRole);
    
    // Default instruction for the regulatory agent
    const defaultInstruction = `あなたはナレッジベースを使用してユーザーの質問に答える親切な規制アシスタントです。
    常に可能な限り事実に基づいて正確に質問に答え、ナレッジベースからの情報源を引用してください。
    規制ガイダンスを提供する際は：
    1. 常にナレッジベースから特定の規制や文書を参照してください
    2. 情報が古い可能性がある場合は示してください
    3. ユーザーが検討すべき関連する規制要件を提案してください
    4. 不確実な場合は、公式の規制機関への相談を推奨してください
    5. 関連する場合は特定の規制が存在する理由の背景を提供してください`;

    // Create regulatory knowledge base and s3 data source for the KB
    const regulatoryKnowledgeBase = new cdkLabsBedrock.KnowledgeBase(scope, `KB-regulatory`, {
        embeddingsModel: cdkLabsBedrock.BedrockFoundationModel.TITAN_EMBED_TEXT_V2_1024,
        instruction: `あなたは世界の石油・ガス施設の規制要件に関してユーザーの質問に事実に基づいて正直に答える親切な質問応答アシスタントです`,
        description: 'Regulatory Knowledge Base',
    });
    const s3docsDataSource = regulatoryKnowledgeBase.addS3DataSource({
        bucket: props.s3Bucket,
        dataSourceName: "a4e-kb-ds-s3-regulatory",
        inclusionPrefixes: ['regulatory-agent/'],
    })

    // Create the Bedrock agent with the role
    const cfnAgentProps: bedrock.CfnAgentProps = {
        agentName: `${resourcePrefix}-agent-${stackUUID}`,
        description: props.description || 'This agent is designed to help with regulatory compliance.',
        instruction: props.instruction || defaultInstruction,
        foundationModel: props.modelId || 'us.anthropic.claude-sonnet-4-20250514-v1:0',
        agentResourceRoleArn: regulatoryAgentRole.roleArn,
        autoPrepare: true,
        knowledgeBases: [{
                knowledgeBaseId: regulatoryKnowledgeBase.knowledgeBaseId,
                description: 'Knowledge Base for regulatory requirements',
                knowledgeBaseState: 'ENABLED'
            }],
    
    };

    // Create the Bedrock agent
    const regulatoryAgent = new bedrock.CfnAgent(
        scope,
        'RegulatoryAgent',
        cfnAgentProps
    );

    // Create an alias for the agent
    const regulatoryAgentAlias = new bedrock.CfnAgentAlias(
        scope,
        'RegulatoryAgentAlias',
        {
            agentId: regulatoryAgent.attrAgentId,
            agentAliasName: `${resourcePrefix}-agent-alias-${stackUUID}`
        }
    );

    regulatoryAgentAlias.addDependency(regulatoryAgent);

    // Apply removal policies
    regulatoryAgent.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    regulatoryAgentAlias.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // Create CloudWatch metrics
    const metric = new cdk.aws_cloudwatch.Metric({
        namespace: 'RegulatoryAgent',
        metricName: 'Invocations',
        dimensionsMap: {
            AgentId: regulatoryAgent.attrAgentId,
            Environment: environment
        }
    });

    // Create CloudWatch alarm
    new cdk.aws_cloudwatch.Alarm(scope, 'RegulatoryAgentErrorAlarm', {
        metric: metric,
        threshold: 5,
        evaluationPeriods: 1,
        alarmDescription: 'Alert when regulatory agent encounters multiple errors',
        comparisonOperator: cdk.aws_cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD
    });

    // Add trust policy conditions
    const cfnRole = regulatoryAgentRole.node.defaultChild as iam.CfnRole;
    cfnRole.addPropertyOverride('AssumeRolePolicyDocument.Statement.0.Condition', {
    StringEquals: {
        'aws:SourceAccount': cdk.Stack.of(scope).account
    }
});
    return {
        regulatoryAgent,
        regulatoryAgentAlias,
        regulatoryAgentRole,
        metric
    };
}
