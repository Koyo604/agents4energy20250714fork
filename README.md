# Agents4Energy - 日本語対応版

初めて生成AIエージェントをデプロイしますか？まずは[このagents4energyサンプルエージェントリポジトリ](https://github.com/aws-samples/sample-agents4energy-agent-template-alpha)から始めてください。

Agents4Energy (A4E) は、エネルギー業界のお客様がAWS上でワークロードを加速するのに役立つ、設定・デプロイが容易なオープンソースのエージェントワークフローセットです。A4Eにより、業界の専門家は貯留層特性評価、坑井修理評価、フィールドデータ分析、サプライチェーン最適化、資産完全性管理など、エネルギー業界の一般的な用途で生成AIアシスタントを使用できます。

## 日本語対応の特徴
- **完全日本語UI**: すべてのユーザーインターフェースが日本語化
- **日本語チャット対応**: 自然な日本語での質問・回答
- **日本語データベース**: 機器名・作業内容が日本語化されたサンプルデータ
- **親切な応答システム**: 曖昧な質問や該当データなしの場合も適切にガイダンス

![A4E Constructs](assets/images/A4E-Open-Source-Architecture.png)

生成人工知能（GenAI）が私たちの働き方を根本的に革命化していることは誇張ではありません。大規模言語モデル（LLM）の機能により、人間とコンピューター間のコミュニケーションギャップが埋められ、すでに生産性の大幅な向上をもたらす新しい働き方が促進されています。エージェントとエージェントワークフローは、もはや技術者だけの用語ではなく、ニュース、トークショー、そして日常会話で毎日言及されています。

エネルギー業界のニーズに対応し、GenAIが提示する大きな力を活用するため、AWSはAgents4Energyを発表いたします。このソリューションにより、オペレーターやサービス会社は既存の技術環境に第6世代のコンピューティングを簡単に組み込むことができます。旅行代理店があなたの代わりに休暇予約の細かい詳細を処理するように、エネルギーエージェントは多様なデータソースと企業システムをスキャンして洞察を解き放ち、あなたの代わりにタスクを完了します。

![Production Agent](assets/images/A4E-ProductionAgentScreenShot.png)

Agents4Energyは、何百人ものエネルギー専門家の業界専門知識と何世紀もの経験を集約し、エネルギー資産運用の日常的な非差別化タスクを簡素化します。あなたとあなたのチームが時間をかけることができないすべての検証、最適化、分析を考えてみてください。これらは、エージェントに作業を設定するのに最適なタスクです。

# AWS Reference Architecture
![Ref Arch](assets/images/A4E-Reference-Architecture.png)

# Solution Deployment
For detailed deployment instructions, please see [DEPLOYMENT.md](DEPLOYMENT.md).

## エージェント開発
このリポジトリで開発を始めるには、以下の手順を実行してください。これらの手順はデプロイ手順とは独立しています。
1. リポジトリをクローンします
1. `npm install` を実行して必要なパッケージをインストールします
1. `npm run ecrAuth` を実行してAWS ECRリポジトリで認証します。これによりLambdaビルドイメージをプルできます
1. `npx ampx sandbox` を実行して開発用の個人サンドボックス環境を作成します
1. 別のターミナルで `npm run dev` を実行してフロントエンドの開発サーバーを起動します。インターネットブラウザーで `localhost:3000` にアクセスしてサーバーにアクセスできます
1. コードを変更すると、フロントエンドとバックエンドの両方にデプロイされます


### 特定のメールアドレスのみサインアップを制限
ユーザーがアカウントにサインアップするとき、メールアドレスのサフィックスが許可リストと照合されます。
許可されるメールアドレスのサフィックスを変更するには、以下の手順に従ってください：
1. AWS Amplifyコンソールで、あなたのブランチに移動します
1. 左サイドバーの「Functions」ボタンをクリックします
1. 関数名に「preSignUp」が含まれる関数を探し、クリックします
1. 「View in Lambda」をクリックします
1. 「Configuration」、そして「Environmental Variables」をクリックします
1. 「ALLOWED_EMAIL_SUFFIXES」という名前の変数は、許可されたメールサフィックスのカンマ区切りリストです。許可したいメールアドレスを反映するようにこの変数を変更してください。空の要素を追加すると（例：`@amazon.com,`）、すべてのメールアドレスが許可されます

## 生産エージェント

### 新しい構造化データの追加
このデータはAmazon Athenaを使用してクエリされます

手順：
1. ファイルドライブの `production-agent/structured-data-files/` キーにデータをアップロードします
1. AWS Glueクローラーが実行され、新しいテーブル定義がAmazon Bedrock Knowledge Baseに読み込まれるまで５分間待ちます
1. これで生産エージェントに新しいデータについて質問できます！

### Add new data source
You can add new data sources thorugh [Amazon Athena Federated Query](https://docs.aws.amazon.com/athena/latest/ug/connect-to-a-data-source.html)

Steps:
1. Configure a new Amazon Athena Federated Query Data Source
2. Tag the data source with key: "AgentsForEnergy" and value: "true"
3. Create a JSON object for each table in the data source. See an example below.
4. Upload the files  

Example Table Definition:
```json
{
  "dataSource": "AwsDataCatalog",
  "database": "production_db_171",
  "tableName": "crawler_pricing",
  "tableDefinition": "\"date\"\tvarchar\n\"wti_price\"\tdouble\n\"brent_price\"\tdouble\n\"volume\"\tbigint"
}
```
## メンテナンスエージェント
![Maintenance Agent](assets/images/A4E-Maintenance-Agent.png)

### 日本語対応機能
- **日本語チャット**: 自然な日本語での質問・回答
- **日本語データ**: 機器名、作業内容が日本語化
- **親切なガイダンス**: 曖昧な質問やデータなしの場合も適切に対応

### データベースのカスタマイズ
Aurora Serverless v2 PostgreSQLデータベースに含まれるデータを変更するには、[DB準備Lambda関数で使用されるINSERT SQL文](amplify/agents/maintenance/lambda)を変更してください。

このLambda関数はいつでも実行してサンプルデータを元のデプロイ状態にリセットできます。これは、エージェントを使用してデータを変更または更新し、text-to-SQLツールの読み書き機能をテストする場合に便利です。
