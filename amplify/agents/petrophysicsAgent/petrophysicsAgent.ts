// Implement the petrophysics agent

import { Construct } from 'constructs';
import { aws_bedrock as bedrock } from 'aws-cdk-lib';
import { aws_s3 as s3 } from 'aws-cdk-lib';
import { aws_ec2 as ec2 } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import { aws_iam as iam } from 'aws-cdk-lib';
import { bedrock as cdkLabsBedrock } from '@cdklabs/generative-ai-cdk-constructs';

interface PetrophysicsAgentProps {
    s3Bucket: s3.IBucket;
    s3Deployment: cdk.aws_s3_deployment.BucketDeployment;

    modelId?: string;
    vpc: ec2.Vpc;
    instruction?: string;
    description?: string;
}

export function petrophysicsAgentBuilder(scope: Construct, props: PetrophysicsAgentProps) {
    const stackUUID = cdk.Names.uniqueResourceName(scope, { maxLength: 3 }).toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(-3);
    const resourcePrefix = 'A4E-Petrophysics';

    // Create IAM role for the Bedrock agent
    const petrophysicsAgentRole = new iam.Role(scope, 'PetrophysicsAgentRole', {
        roleName: `AmazonBedrockExecutionRole_${resourcePrefix}-${stackUUID}`,
        assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
        description: 'IAM role for Petrophysics Agent to access knowledge bases',
    });

    // Add Bedrock permissions
    petrophysicsAgentRole.addToPolicy(
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
    petrophysicsAgentRole.addToPolicy(
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
    props.s3Bucket.grantRead(petrophysicsAgentRole);

    // Default instruction for the petrophysics agent
    const defaultInstruction = `あなたはナレッジベースを使用してユーザーの質問に答える親切な岩石物理アシスタントです。
    常に事実に基づいて質問に答え、ナレッジベースからの情報源を引用してください。
    岩石物理分析を提供する際は：
    1. 利用可能な場合は特定の坑井ログデータや測定値を参照してください
    2. 測定の背景にある物理原理を説明してください
    3. 関連する場合はデータ品質や不確実性について討論してください
    4. 価値のある追加の測定や分析を提案してください
    5. 分析が貯留層特性評価にどのように影響するかの背景を提供してください`;

    // Create petrophysics knowledge base
    const petrophysicsKnowledgeBase = new cdkLabsBedrock.KnowledgeBase(scope, `KB-petrophysics`, {
        embeddingsModel: cdkLabsBedrock.BedrockFoundationModel.TITAN_EMBED_TEXT_V2_1024,
        instruction: `あなたは岩石物理と坑井ログ解析に関してユーザーの質問に事実に基づいて正直に答える親切な質問応答アシスタントです`,
        description: 'Petrophysics Knowledge Base',
    });

    const s3docsDataSource = petrophysicsKnowledgeBase.addS3DataSource({
        bucket: props.s3Bucket,
        dataSourceName: "a4e-kb-ds-s3-petrophysics",
        inclusionPrefixes: ['petrophysics-agent/'],
    });

    // Create the Bedrock agent
    const cfnAgentProps: bedrock.CfnAgentProps = {
        agentName: `${resourcePrefix}-agent-${stackUUID}`,
        description: props.description || 'This agent is designed to help with petrophysical analysis.',
        instruction: props.instruction || defaultInstruction,
        foundationModel: props.modelId || 'anthropic.claude-3-haiku-20240307-v1:0',
        agentResourceRoleArn: petrophysicsAgentRole.roleArn,
        autoPrepare: true,
        knowledgeBases: [{
            knowledgeBaseId: petrophysicsKnowledgeBase.knowledgeBaseId,
            description: 'Knowledge Base for petrophysics',
            knowledgeBaseState: 'ENABLED'
        }],
    };

    // Create the Bedrock agent
    const petrophysicsAgent = new bedrock.CfnAgent(
        scope,
        'PetrophysicsAgent',
        cfnAgentProps
    );

    // Create an alias for the agent
    const petrophysicsAgentAlias = new bedrock.CfnAgentAlias(
        scope,
        'PetrophysicsAgentAlias',
        {
            agentId: petrophysicsAgent.attrAgentId,
            agentAliasName: `${resourcePrefix}-agent-alias-${stackUUID}`
        }
    );

    petrophysicsAgentAlias.addDependency(petrophysicsAgent);

    // Apply removal policies
    petrophysicsAgent.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    petrophysicsAgentAlias.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // Create CloudWatch metrics
    const metric = new cdk.aws_cloudwatch.Metric({
        namespace: 'PetrophysicsAgent',
        metricName: 'Invocations',
        dimensionsMap: {
            AgentId: petrophysicsAgent.attrAgentId,
            AgentAlias: petrophysicsAgentAlias.agentAliasName
        }
    });

    return {
        petrophysicsAgent,
        petrophysicsAgentAlias,
        metric

    }
}
