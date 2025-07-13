// import { BedrockAgent } from "@aws-sdk/client-bedrock-agent"
import outputs from '@/../amplify_outputs.json';

type BaseAgent = {
    name: string
    samplePrompts: string[]
    source: 'bedrockAgent' | 'graphql'
}

export type BedrockAgent = BaseAgent & {
    source: "bedrockAgent"
    agentId: string
    agentAliasId: string
}

export type LangGraphAgent = BaseAgent & {
    source: "graphql"
    invokeFieldName: string
}

export const defaultAgents: { [key: string]: BaseAgent | BedrockAgent | LangGraphAgent } = {
    PlanAndExecuteAgent: {
        name: `生産エージェント`,
        source: `graphql`,
        samplePrompts: [
            `今朝API番号30-045-29202の坑井がガス生産を停止し、チュービングに穴があることが示されました。
            坑井ファイルから見つかったすべての運用イベントの表を作成してください。
            すべての歴史的月別生産率をクエリし、イベントデータと生産データの両方を含むプロットを作成してください。
            坑井の残存生産価値を推定してください。
            坑井の修理手順を作成し、修理コストを推定し、財務指標を計算してください。
            詳細なコストと手順データを含む坑井修理に関する経営報告書を作成してください。
            すべてのステップでAIロールを使用してください。
            `.replace(/^\s+/gm, ''),
            `API番号30-045-29202の坑井ファイルを検索し、作業タイプ（掘削、完成、修理、廃坑、その他）、作業詳細を説明するレポートテキスト、文書タイトルを含む表を作成してください。
            また、SQLクエリを実行してこの坑井の月別総石油、ガス、水生産量を取得してください。
            イベントデータと生産データの両方を含むプロットを作成してください。`.replace(/^\s+/gm, ''),
            `API番号30-045-29202の坑井について1900年以降の月別総石油、ガス、水生産量をプロットしてください`,
            `私の性格に最も適した人工揚水方式は何ですか？`
        ]
    },
    MaintenanceAgent: {
        name: "メンテナンスエージェント",
        source: "bedrockAgent",
        agentId: outputs.custom.maintenanceAgentId,
        agentAliasId: outputs.custom.maintenanceAgentAliasId,
        samplePrompts: [
            "バイオディーゼルユニットにはいくつのタンクがありますか？",
            "2024年9月にバイオディーゼルユニットで発生した主要なインシデントと対応措置を教えてください。",
        ],
    } as BedrockAgent,
    RegulatoryAgent: {
        name: "規制エージェント",
        source: "bedrockAgent",
        agentId: outputs.custom.regulatoryAgentId,
        agentAliasId: outputs.custom.regulatoryAgentAliasId,
        samplePrompts: [
            "米国での漏洩排出の監視と報告に関する要件は何ですか？",
            "ブラジルでの海上油井の廃止に関する要件は何ですか？",
        ],
    } as BedrockAgent,
    PetrophysicsAgent: {
        name: "岩石物理エージェント",
        source: "bedrockAgent",
        agentId: outputs.custom.petrophysicsAgentId,
        agentAliasId: outputs.custom.petrophysicsAgentAliasId,
        samplePrompts: [
            "流体置換モデリングの概要を教えてください",
            "Gassmann方程式の入力パラメータを教えてください",
            "AVOクラスとは何ですか？",
            "vp=3.5 km/s、vs=1.95 km/s、体積密度=2.23 gm/ccの湿潤砂岩が頁岩に覆われている場合の切片と勾配値を計算し、AVOクラスを決定してください。",
            "vp=3.5 km/s、vs=1.95 km/s、体積密度=2.23 gm/ccの湿潤砂岩で、流体飽和度が80%の石油の場合の予想地震速度はどの程度ですか？標準的な仮定を使用してください。"
            ],
    } as BedrockAgent
}