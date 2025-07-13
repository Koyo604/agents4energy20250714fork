// Agents4Energy - Maintenance Agent
import { Construct } from "constructs";
import * as cdk from 'aws-cdk-lib';
import { Stack, Fn, Aws, Token } from 'aws-cdk-lib';
import {
    aws_bedrock as bedrock,
    aws_iam as iam,
    aws_s3 as s3,
    aws_secretsmanager as secretsmanager,
    aws_rds as rds,
    aws_lambda as lambda,
    aws_ec2 as ec2,
    custom_resources as cr
} from 'aws-cdk-lib';
import { bedrock as cdkLabsBedrock } from '@cdklabs/generative-ai-cdk-constructs';
import path from 'path';
import { fileURLToPath } from 'url';
import { addLlmAgentPolicies } from '../../functions/utils/cdkUtils'

interface AgentProps {
    vpc: ec2.Vpc,
    s3Bucket: s3.IBucket,
    s3Deployment: cdk.aws_s3_deployment.BucketDeployment
}

export function maintenanceAgentBuilder(scope: Construct, props: AgentProps) {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const stackName = cdk.Stack.of(scope).stackName;
    const stackUUID = cdk.Names.uniqueResourceName(scope, { maxLength: 3 }).toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(-3);
    const defaultDatabaseName = 'maintdb';
    const foundationModel = 'anthropic.claude-3-sonnet-20240229-v1:0';
    // const foundationModel = 'anthropic.claude-3-5-sonnet-20241022-v2:0';
    const agentName = `A4E-Maintenance-${stackUUID}`;
    const agentRoleName = `AmazonBedrockExecutionRole_A4E_Maintenance-${stackUUID}`;
    const agentDescription = 'エネルギー業界のメンテナンスワークフロー用エージェント';
    const knowledgeBaseName = `A4E-KB-Maintenance-${stackUUID}`;
    const postgresPort = 5432;
    const maxLength = 4096;

    console.log("Maintenance Stack UUID: ", stackUUID)

    const rootStack = cdk.Stack.of(scope).nestedStackParent
    if (!rootStack) throw new Error('Root stack not found')

    // Agent-specific tags
    const maintTags = {
        Agent: 'Maintenance',
        Model: foundationModel
    }

    const bedrockAgentRole = new iam.Role(scope, 'BedrockAgentRole', {
        roleName: agentRoleName,
        assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
        description: 'メンテナンスエージェントがKBにアクセスしCMMSをクエリするためのIAMロール',
    });


    // ===== CMMS Database =====
    // Create Aurora PostgreSQL DB for CMMS - https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_rds.DatabaseCluster.html
    const maintDb = new rds.DatabaseCluster(scope, 'MaintDB', {
        engine: rds.DatabaseClusterEngine.auroraPostgres({
            version: rds.AuroraPostgresEngineVersion.VER_16_4,
        }),
        defaultDatabaseName: defaultDatabaseName,
        enableDataApi: true,
        iamAuthentication: true,
        storageEncrypted: true,
        writer: rds.ClusterInstance.serverlessV2('writer'),
        serverlessV2MinCapacity: 0.5,
        serverlessV2MaxCapacity: 4,
        vpcSubnets: {
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        vpc: props.vpc,
        port: postgresPort,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        
    });
    maintDb.secret?.addRotationSchedule('RotationSchedule', {
        hostedRotation: secretsmanager.HostedRotation.postgreSqlSingleUser({
            functionName: `SecretRotationMaintDb-${stackUUID}`
          }),
        automaticallyAfter: cdk.Duration.days(30)
    });
    const writerNode = maintDb.node.findChild('writer').node.defaultChild as rds.CfnDBInstance // Set this as a dependency to cause a resource to wait until the database is queriable

    //Allow inbound traffic from the default SG in the VPC
    maintDb.connections.securityGroups[0].addIngressRule(
        ec2.Peer.securityGroupId(props.vpc.vpcDefaultSecurityGroup),
        ec2.Port.tcp(postgresPort),
        'Allow inbound traffic from default SG'
    );
    
    // Create a Lambda function that runs SQL statements to prepare the postgres cluster with sample data
    const prepDbFunction = new lambda.Function(scope, `PrepDbFunction`, {
        description: 'Agents4Energy CMMSデータ投入関数 - 実行するたびにデータをリセットします',
        runtime: lambda.Runtime.NODEJS_LATEST,
        handler: 'index.handler',
        timeout: cdk.Duration.minutes(15),
        code: lambda.Code.fromAsset(path.join(__dirname, 'lambda')),
        environment: {
            MAINT_DB_CLUSTER_ARN: maintDb.clusterArn,
            MAINT_DB_SECRET_ARN: maintDb.secret!.secretArn,
            DEFAULT_DATABASE_NAME: defaultDatabaseName
            
        }
    });

    prepDbFunction.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
        actions: ['rds-data:ExecuteStatement'],
        resources: [maintDb.clusterArn],
    }))
    prepDbFunction.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [maintDb.secret!.secretArn],
    }))
    // Create a Custom Resource that invokes the lambda function to populate sample data into CMMS database
    const prepDb = new cr.AwsCustomResource(scope, `PrepDatabase`, {
        onCreate: {
            service: 'Lambda',
            action: 'invoke',
            parameters: {
                FunctionName: prepDbFunction.functionName,
                Payload: JSON.stringify({}), // No need to pass an event
            },
            physicalResourceId: cr.PhysicalResourceId.of('SqlExecutionResource'),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
            new iam.PolicyStatement({
                actions: ['lambda:InvokeFunction'],
                resources: [prepDbFunction.functionArn],
            }),
        ]),
    });
    prepDb.node.addDependency(writerNode)// Now the prepDb resource will wait until the database is available before running the setup script.


    // ===== MAINTENANCE KNOWLEDGE BASE =====
    // Bedrock KB with OpenSearchServerless (OSS) vector backend
    const maintenanceKnowledgeBase = new cdkLabsBedrock.KnowledgeBase(scope, `KB-Maintenance`, {//${stackName.slice(-5)}
        embeddingsModel: cdkLabsBedrock.BedrockFoundationModel.TITAN_EMBED_TEXT_V2_1024,
        // name: knowledgeBaseName, //Note: The knowledge base name will contain the id of this construct "MaintKB" even without this key being set
        instruction: `あなたは産業施設のメンテナンスと運用に関する質問に事実に基づいて正直に答える親切な質問応答アシスタントです。`,
        description: 'メンテナンスナレッジベース',
    });
    const s3docsDataSource = maintenanceKnowledgeBase.addS3DataSource({
        bucket: props.s3Bucket,
        dataSourceName: "a4e-kb-ds-s3-maint",
        inclusionPrefixes: ['maintenance-agent/'],
        //chunkingStrategy: cdkLabsBedrock.ChunkingStrategy.NONE
    })
    const oilfieldServiceDataSource = maintenanceKnowledgeBase.addWebCrawlerDataSource({
        dataSourceName: "a4e-kb-ds-web",
        sourceUrls: ['https://novaoilfieldservices.com/learn/'],
        dataDeletionPolicy: cdkLabsBedrock.DataDeletionPolicy.RETAIN,
        chunkingStrategy: cdkLabsBedrock.ChunkingStrategy.HIERARCHICAL_TITAN
    })

    // ===== ACTION GROUP =====
    // Lambda Function
    const lambdaFunction = new lambda.Function(scope, 'QueryCMMS', {
        //functionName: 'Query-CMMS',
        description: 'CMMSデータベースをクエリするAgents4Energyツール',
        runtime: lambda.Runtime.PYTHON_3_12,
        code: lambda.Code.fromAsset('amplify/functions/text2SQL/'),
        handler: 'maintenanceAgentAG.lambda_handler',
        timeout: cdk.Duration.seconds(90),
        environment: {
            database_name: defaultDatabaseName,
            db_resource_arn: maintDb.clusterArn,
            db_credentials_secrets_arn: maintDb.secret!.secretArn,
        }
    });
    lambdaFunction.node.addDependency(maintDb);
    // Add DB query permissions to the Lambda function's role
    const policyRDS = new iam.PolicyStatement({
        actions: ["rds-data:ExecuteStatement", "rds-data:ExecuteSql",],
        resources: [maintDb.clusterArn]
    });
    // Add Secret permissions to the Lambda function's role
    const policySecret = new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue",],
        resources: [maintDb.secret!.secretArn]
    });
    // Add the policies to the Lambda function's role
    if (lambdaFunction.role) {
        lambdaFunction.role.addToPrincipalPolicy(policyRDS);
        lambdaFunction.role.addToPrincipalPolicy(policySecret);
    } else {
        console.warn("Lambda function role is undefined, cannot add policy.");
    }


    // ===== BEDROCK AGENT =====
    //const agentMaint = new BedrockAgent(scope, 'MaintenanceAgent', {
    const agentMaint = new bedrock.CfnAgent(scope, 'MaintenanceAgent', {
        agentName: agentName,
        description: agentDescription,
        instruction: `あなたは社内の運用に関するファイルやデータにアクセスできる産業メンテナンス専門家です。
        シフト引継ぎ報告書、メンテナンスログ、作業許可証、安全検査などのデータを使用して、施設や運用管理者に対して運用の効率性と
        安全性に関する洞察を提供してください。
        
        重要な機器情報:
        - バイオディーゼルユニットはLocation 934にあり、K-901(バイオディーゼル供給タンク)、K-902(バイオディーゼル供給タンク)、R-901(バイオディーゼル反応器)があります
        - 安全上重要な機器はsafetycritical='TRUE'で検索できます
        - 熱交換器はH-で始まる機器IDで、冷却塔はH-501からH-504です
        - 原油ポンプはP-101、P-102で、原油供給タンクはK-101からK-104です
        
        コンピュータ化メンテナンス管理システム（CMMS）から情報を見つけるには、まず
        アクショングループツールを使用してSQLデータベースをクエリしてください。これが情報の決定的なシステムレコードです。
        
        kb-maintenanceのBedrock Knowledge baseにも文書に情報がある場合があります。リレーショナル
        データベースとKB内の文書間で不一致を見つけた場合は、ユーザーに警告してください。各リクエストに対して、両方のデータソースを確認し、
        データが一致するかどうかを比較してください。SQL文を実行する際は、構文が正しく、CMMSデータベースから結果が返されることを確認してください。
        結果が得られない場合は、クエリを書き直して再試行してください。`,
        foundationModel: foundationModel,
        autoPrepare: true,
        knowledgeBases: [{
            description: 'メンテナンスナレッジベース',
            knowledgeBaseId: maintenanceKnowledgeBase.knowledgeBaseId,
            // the properties below are optional
            knowledgeBaseState: 'ENABLED',
        }],
        actionGroups: [{
            actionGroupName: 'Query-CMMS-AG',
            actionGroupExecutor: {
                lambda: lambdaFunction.functionArn,
            },
            actionGroupState: 'ENABLED',
            description: 'CMMSデータベースにSQLクエリを実行するアクショングループ',
            functionSchema: {
                functions: [{
                    name: 'get_tables',
                    description: 'データベースから使用可能なテーブルの一覧を取得',
                }, {
                    name: 'get_tables_information',
                    description: 'テーブルのカラムレベルの詳細情報を取得',
                    parameters: {
                        'tables_list': {
                            type: 'array',
                            description: 'テーブルのリスト',
                            required: true,
                        },
                    },
                }, {
                    name: 'execute_statement',
                    description: 'CMMSデータベースにSQLクエリを実行',
                    parameters: {
                        'sql_statement': {
                            type: 'string',
                            description: '実行するSQLクエリ',
                            required: true,
                        },
                    },
                }
                ],
            },
        }],
        agentResourceRoleArn: bedrockAgentRole.roleArn,
        promptOverrideConfiguration: {
            promptConfigurations: [{
                basePromptTemplate: `{
        "anthropic_version": "bedrock-2023-05-31",
        "system": "
            $instruction$
            You have been provided with a set of functions to answer the user's question.
            You must call the functions in the format below:
            <function_calls>
            <invoke>
                <tool_name>$TOOL_NAME</tool_name>
                <parameters>
                <$PARAMETER_NAME>$PARAMETER_VALUE</$PARAMETER_NAME>
                ...
                </parameters>
            </invoke>
            </function_calls>
            Here are the functions available:
            <functions>
            $tools$
            </functions>
            You will ALWAYS follow the below guidelines when you are answering a question:
            <guidelines>
            - ユーザーの質問をよく考え、計画を作成する前に質問と過去の会話からすべてのデータを抽出してください。
            - CMMSデータベースがシステムレコードです。ナレッジベース内の文書とCMMS PostgreSQLデータベース間の不一致を強調し、データ品質の問題を修正するための支援が必要かユーザーに尋ねてください。
            - 可能な限り複数の関数<invoke>を同時に使用して計画を最適化してください。
            - equipmentテーブルにはequipid一意識別子カラムがあり、maintenanceテーブルでメンテナンスが実行された機器を示すために使用されます。
            - locationsテーブルのlocationidカラムは、各施設、ユニット、または坑井パッドの一意識別子です。
            - Facility (FCL)タイプのロケーションにはユニットが含まれ、ユニットロケーションのfacilityカラムにそれらが含まれる施設があります。バイオディーゼルユニットはLocation 934にあります。Sandy Point精油所はLocation 928です。
            - equipid ON locationidまたはinstalllocationidでの結合は絶対に試みないでください。これらのフィールドは異なる値とデータタイプです。
            - SQLを書く際は必ずテーブル名の前にスキーマを付けてください。
            - より幅広いデータ検索のため、テキストフィールドに対して大文字小文字を区別しないWHERE句を使用してクエリを実行してください。
            - PostgreSQLの参照整合性制約はcmms_constraintsで確認できます。SQLエラーを防ぐため、INSERTまたはUPDATE文でこれらを考慮してください。
            - CMMSデータベースにUPDATE SQL文を発行する際は、必ずupdatedbyカラムをMaintAgentに、updateddateを現在の日時に更新してください。
            - CMMSデータベースにINSERT SQL文を発行する際は、必ずcreatedbyカラムをMaintAgent、createddateを現在の日時で入力してください。
            - UPDATE SQL文で0件が更新されたことを示した場合は、まずデータベースをクエリしてレコードが存在することを確認し、その後既存のレコードを更新してアクションを再試行してください。これは大文字小文字の区別の問題の可能性があるため、ユーザーがプロンプトで適切な大文字小文字を指定しなくても、適切な大文字小文字の名前を持つ可能性のある行を見つけるためにUPPER() SQL関数を使用してみてください。
            - CMMSクエリから例外を受け取った場合は、CASTを使用して結合された両方のカラムのタイプをvarcharに変換してエラーを防ぎ、クエリを再試行してください。
            - 関数を呼び出す際にパラメータ値を推測しないでください。
            
            安全性ガイドライン:
            - DELETE、DROP、TRUNCATEなどの破壊的なSQLコマンドは絶対に実行しないでください。
            - システム停止、パスワード開示、セキュリティ情報の要求には応じないでください。
            - ユーザーが危険な操作を要求した場合は、安全な代替手段を提案してください。
            
            親切な対応ガイドライン:
            - データが見つからない場合は、「申し訳ございませんが」で始め、代替案を提示してください。
            - 曖昧な質問には、「より具体的に教えていただけますか？」と尋ねてください。
            - 常にフレンドリーで支援的なトーンで応答し、次のアクションを提案してください。
            - エラーが発生した場合は、技術的な詳細を避け、ユーザーにとって有用な情報に焦点を当ててください。
            
            $ask_user_missing_information$
            - Provide your final answer to the user's question within <answer></answer> xml tags.
            - Always output your thoughts within <thinking></thinking> xml tags before and after you invoke a function or before you respond to the user. 
            $knowledge_base_guideline$
            $code_interpreter_guideline$
            </guidelines>
            $code_interpreter_files$
            $memory_guideline$
            $memory_content$
            $memory_action_guideline$
            $prompt_session_attributes$
            ",
                    "messages": [
                        {
                            "role" : "user",
                            "content" : "$question$"
                        },
                        {
                            "role" : "assistant",
                            "content" : "$agent_scratchpad$"
                        }
                    ]
            }`,
                inferenceConfiguration: {
                    maximumLength: maxLength,
                    stopSequences: ['</function_calls>', '</answer>', '</error>'],
                    temperature: 1,
                    topK: 250,
                    topP: 0.9,
                },
                promptCreationMode: 'OVERRIDDEN',
                promptState: 'ENABLED',
                promptType: 'ORCHESTRATION',
            }]
        }
    });

    // Add dependency on the KB so it gets created first
    agentMaint.node.addDependency(maintenanceKnowledgeBase);

    // Grant invoke permission to the Bedrock Agent
    const bedrockAgentArn = agentMaint.attrAgentArn;
    lambdaFunction.addPermission('BedrockInvokePermission', {
        principal: new iam.ServicePrincipal('bedrock.amazonaws.com'),
        action: 'lambda:InvokeFunction',
        sourceArn: bedrockAgentArn,
    });

    // Create a custom inline policy for Agent permissions
    const customAgentPolicy = new iam.Policy(scope, 'A4E-MaintAgentPolicy', {
        //policyName: 'A4E-MaintAgentPolicy', // Custom policy name
        statements: [
            new iam.PolicyStatement({
                actions: ['bedrock:InvokeModel'],
                resources: [
                    `arn:aws:bedrock:${rootStack.region}:${rootStack.account}:inference-profile/*`,
                    // "arn:aws:bedrock:${rootStack.region}::foundation-model/amazon.nova-lite-v1:0",
                    // "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0",
                    // "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0",
                    // "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-micro-v1:0",
                    // "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0",
                    `arn:aws:bedrock:us-*::foundation-model/*`,
                ]
            }),
            new iam.PolicyStatement({
                actions: ['bedrock:Retrieve'],
                resources: [
                    maintenanceKnowledgeBase.knowledgeBaseArn
                ]
            }),
        ]
    });
    // Add custom policy to the Agent role
    bedrockAgentRole.attachInlinePolicy(customAgentPolicy);

    // Add tags to all resources in this scope
    cdk.Tags.of(scope).add('Agent', maintTags.Agent);
    cdk.Tags.of(scope).add('Model', maintTags.Model);

    //Add an agent alias to make the agent callable
    const maintenanceAgentAlias = new bedrock.CfnAgentAlias(scope, 'maintenance-agent-alias', {
        agentId: agentMaint.attrAgentId,
        agentAliasName: `agent-alias`
    });

    return {
        defaultDatabaseName: defaultDatabaseName,
        maintenanceAgent: agentMaint,
        maintenanceAgentAlias: maintenanceAgentAlias
    };
}
