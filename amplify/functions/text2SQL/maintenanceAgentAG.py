import os
import json
import boto3
from datetime import datetime

rds_client = boto3.client('rds-data')
database_name = os.environ.get('database_name')
db_resource_arn = os.environ.get('db_resource_arn')
db_credentials_secrets_arn = os.environ.get('db_credentials_secrets_arn')

def get_tables():
    sql = "select * from information_schema.tables where table_name not like 'pg_%' and table_schema <> 'information_schema'"
    print(f"Attempting to run SQL: {sql}")
    tables = execute_statement(sql)
    return tables
    
def get_tables_information(t: list[str]):
    sql = "select table_name, column_name, ordinal_position, is_nullable, data_type from information_schema.columns where table_name not like 'pg_%' and table_schema <> 'information_schema'"
    print(f"Attempting to run SQL: {sql}")
    tables_information = execute_statement(sql)
    
    # Add Japanese-English mapping information for better query generation
    mapping_info = {
        "equipment_mappings": {
            "熱交換器": "Heat Exchanger",
            "冷却塔": "Cooling Tower", 
            "脱塩装置": "Desalter",
            "原油供給タンク": "Crude Supply Tank",
            "バイオディーゼル": "Biodiesel",
            "反応器": "Reactor",
            "ポンプ": "Pump"
        },
        "suggested_questions": {
            "equipment": [
                "すべての機器を教えてください",
                "バイオディーゼルユニットの設備を教えてください",
                "安全上重要な機器はどれですか？",
                "熱交換器の一覧を教えてください"
            ],
            "maintenance": [
                "最近のメンテナンス作業を教えてください",
                "今月のメンテナンス予定はありますか？",
                "高額なメンテナンス作業を教えてください",
                "緊急修理の履歴を教えてください"
            ],
            "costs": [
                "メンテナンスコストの高い作業は何ですか？",
                "今年のメンテナンス費用の合計を教えてください",
                "コスト割りの高い機器はどれですか？"
            ]
        },
        "status_mappings": {
            "稼働中": "ACT",
            "新規": "NEW", 
            "廃止": "VFD",
            "完了": "COM"
        },
        "maintenance_mappings": {
            "予防保全": "PM",
            "修正保全": "CM",
            "定期点検": "PM",
            "故障修理": "CM",
            "緊急修理": "CM",
            "年次点検": "PM"
        },
        "time_mappings": {
            "最近": "CURRENT_DATE - INTERVAL '30 days'",
            "今月": "DATE_TRUNC('month', CURRENT_DATE)",
            "先月": "DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')",
            "今年": "DATE_TRUNC('year', CURRENT_DATE)",
            "昨年": "DATE_TRUNC('year', CURRENT_DATE - INTERVAL '1 year')"
        },
        "important_queries": {
            "safety_critical": "SELECT * FROM equipment WHERE safetycritical = 'TRUE'",
            "biodiesel_equipment": "SELECT * FROM equipment WHERE UPPER(equipname) LIKE '%バイオディーゼル%' OR installlocationid = 934",
            "recent_maintenance": "SELECT * FROM maintenance WHERE actualDateStart >= CURRENT_DATE - INTERVAL '30 days'",
            "equipment_with_maintenance": "SELECT e.equipname, e.equipid, e.safetycritical, m.maintname, m.actualDateStart, m.estcost FROM equipment e LEFT JOIN maintenance m ON e.equipid = m.equipid ORDER BY m.actualDateStart DESC",
            "maintenance_by_type": "SELECT mt.mainttypename, COUNT(*) as count, AVG(m.effortHours) as avg_hours FROM maintenance m JOIN mainttypes mt ON m.mainttypeid = mt.mainttypeid GROUP BY mt.mainttypename",
            "equipment_by_location": "SELECT l.locationname, COUNT(e.equipid) as equipment_count FROM locations l LEFT JOIN equipment e ON l.locationid = e.installlocationid GROUP BY l.locationname",
            "high_cost_maintenance": "SELECT * FROM maintenance WHERE estcost > 10000 ORDER BY estcost DESC",
            "overdue_maintenance": "SELECT * FROM maintenance WHERE planneddateend < CURRENT_DATE AND statusid != 'COM'"
        }
    }
    
    return {"tables_info": tables_information, "mappings": mapping_info}

def get_question_suggestions(category="general"):
    """Get suggested questions for users"""
    mapping_info = {
        "suggested_questions": {
            "equipment": [
                "すべての機器を教えてください",
                "バイオディーゼルユニットの設備を教えてください",
                "安全上重要な機器はどれですか？"
            ],
            "maintenance": [
                "最近のメンテナンス作業を教えてください",
                "今月のメンテナンス予定はありますか？",
                "高額なメンテナンス作業を教えてください"
            ]
        }
    }
    
    return {"suggestions": mapping_info["suggested_questions"]}

def detect_vague_question(user_input):
    """Detect if user question is too vague"""
    vague_patterns = [
        "何か", "どう", "状況", "問題", "全般", "概要", "どんな", "なんか"
    ]
    
    specific_indicators = [
        "熱交換器", "冷却塔", "バイオディーゼル", "ポンプ", "タンク", "メンテナンス", "修理", "点検"
    ]
    
    # Count vague indicators
    vague_count = sum(1 for pattern in vague_patterns if pattern in user_input)
    specific_count = sum(1 for indicator in specific_indicators if indicator in user_input)
    
    # Question is vague if it has vague terms but no specific terms
    if vague_count > 0 and specific_count == 0:
        return True
    
    # Question is vague if it's too short
    if len(user_input) < 8:
        return True
    
    return False

def execute_statement(sql):
    print(">>>>> EXECUTE_SQL_STATEMENT: Attempting to run SQL: " + sql)
    
    # SQL optimization for Japanese queries
    optimized_sql = optimize_japanese_sql(sql)
    
    try:
        response = rds_client.execute_statement(
            secretArn=db_credentials_secrets_arn,
            database=database_name,
            resourceArn=db_resource_arn,
            sql=optimized_sql
        )
        
        # Check if query returned empty results
        if 'records' in response and len(response['records']) == 0:
            return generate_helpful_empty_response(sql)
        
        return response
        
    except Exception as e:
        return generate_helpful_error_response(str(e), sql)

def generate_helpful_empty_response(sql):
    """Generate helpful response when query returns no results"""
    # Analyze the SQL to provide context-specific suggestions
    context_suggestions = {
        "equipment": "利用可能な機器を確認するには『すべての機器を教えて』と質問してみてください。",
        "maintenance": "メンテナンス履歴を確認するには『最近のメンテナンス作業』と質問してみてください。",
        "safety": "安全重要機器については『安全上重要な機器』と質問してみてください。",
        "biodiesel": "バイオディーゼルユニットについては『バイオディーゼルユニットの設備』と質問してみてください。"
    }
    
    # Check for specific non-existent data patterns
    scope_clarifications = []
    if "原子力" in sql or "発電所" in sql:
        scope_clarifications.append("このシステムは石油・ガス精製施設のデータのみを含んでいます。")
    
    if "昨日" in sql or "今日" in sql:
        scope_clarifications.append("データは2003年から2024年までの期間をカバーしています。")
    
    if any(pattern in sql for pattern in ["XYZ", "ABC", "999"]):
        scope_clarifications.append("機器IDは『H-』（熱交換器）、『K-』（タンク）、『P-』（ポンプ）などの形式です。")
    
    suggestion_text = "\n".join([f"• {suggestion}" for suggestion in context_suggestions.values()])
    scope_text = "\n".join([f"• {clarification}" for clarification in scope_clarifications])
    
    message = f"申し訳ございませんが、該当するデータが見つかりませんでした。"
    
    if scope_clarifications:
        message += f"\n\nデータ範囲について：\n{scope_text}"
    
    message += f"\n\n以下のような質問をお試しください：\n{suggestion_text}"
    
    return {
        "records": [],
        "helpful_message": message
    }

def generate_helpful_error_response(error, sql):
    """Generate helpful response when SQL execution fails"""
    common_fixes = {
        "syntax error": "質問をより具体的にしていただけますか？例：『熱交換器のメンテナンス履歴』",
        "column": "指定された項目が見つかりません。利用可能な機器や作業内容については『機器一覧』と質問してください。",
        "table": "データベースの構造に問題があります。システム管理者にお問い合わせください。"
    }
    
    helpful_message = "申し訳ございませんが、質問を理解できませんでした。\n\n"
    
    for error_type, fix in common_fixes.items():
        if error_type in error.lower():
            helpful_message += fix
            break
    else:
        helpful_message += "より具体的な質問をしていただけますか？例：『バイオディーゼルタンクの状態』"
    
    return {
        "error": error,
        "helpful_message": helpful_message
    }

def optimize_japanese_sql(sql):
    """Optimize SQL for Japanese text searches"""
    # Add UPPER() for case-insensitive Japanese searches
    if 'LIKE' in sql.upper() and not 'UPPER(' in sql.upper():
        import re
        sql = re.sub(r"(\w+)\s+LIKE\s+'([^']+)'", r"UPPER(\1) LIKE UPPER('\2')", sql, flags=re.IGNORECASE)
    
    # Ensure schema prefix for all table names
    common_tables = ['equipment', 'maintenance', 'locations', 'mainttypes', 'statustypes']
    for table in common_tables:
        if f' {table} ' in sql.lower() and f'public.{table}' not in sql.lower():
            sql = sql.replace(f' {table} ', f' public.{table} ')
            sql = sql.replace(f' {table.upper()} ', f' public.{table} ')
    
    return sql


# MAIN LAMBDA FUNCTION ENTRY POINT
def lambda_handler(event, context):
    agent = event['agent']
    actionGroup = event['actionGroup']
    function = event['function']
    parameters = event.get('parameters', [])
    
    print(f"Received request to call {function} with params: {parameters}")

    # Set a default ERROR message in case the correct function could not be determined
    responseBody =  {"TEXT": {"body": "ERROR: No function found to run".format(function)}}
    
    # Figure out what tables are in the database
    if function == "get_tables":
        tables = get_tables()
        responseBody = {"TEXT": {"body": f"<tables_list>{tables}</tables_list>"}}
    
    # Get definition of the tables - column names help to create the query SQL
    elif function == "get_tables_information":
        tables = None
        for param in parameters:
            if param["name"] == "tables_list":
                tables = param["value"]
        if not tables:
            raise Exception("Missing mandatory parameter: tables_list")
        print(tables)    
        table_information = get_tables_information(tables)
        responseBody = {"TEXT": {"body": f"<tables_information>{table_information}</tables_information>"}}
    
    # Get question suggestions to help users
    elif function == "get_question_suggestions":
        category = "general"
        for param in parameters:
            if param["name"] == "category":
                category = param["value"]
        suggestions = get_question_suggestions(category)
        responseBody = {"TEXT": {"body": f"<question_suggestions>{suggestions}</question_suggestions>"}}
    
    # Business data queries
    else:
        for param in parameters:
            if param["name"] == 'sql_statement':
                sql = param["value"]
                # Remove newline characters
                sql = sql.replace("\n", " ")
                print(f"Running agent provided SQL: {sql}")
                results = execute_statement(sql)
                responseBody = {"TEXT": {"body": f"<results>{results}</results>"}}
        if 'sql' not in locals():
            raise Exception("Missing SQL statement")
        
    action_response = {
        'actionGroup': actionGroup,
        'function': function,
        'functionResponse': {
            'responseBody': responseBody
        }
    }

    function_response = {
        "response": action_response,
        "messageVersion": event["messageVersion"],
    }

    print("Response: {}".format(action_response))
    return function_response
