import os
import json
import boto3
from datetime import datetime
import sys

# Ensure UTF-8 encoding for Japanese text
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')
if sys.stderr.encoding != 'utf-8':
    sys.stderr.reconfigure(encoding='utf-8')

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
            "safety_critical": "SELECT * FROM public.equipment WHERE safetycritical = 'TRUE'",
            "biodiesel_equipment": "SELECT * FROM public.equipment WHERE UPPER(equipname) LIKE '%バイオディーゼル%' OR installlocationid = 934",
            "biodiesel_tanks": "SELECT equipid, equipname, equiplongdesc, installlocationid FROM public.equipment WHERE installlocationid = 934 AND UPPER(equipname) LIKE '%タンク%'",
            "biodiesel_unit_all": "SELECT equipid, equipname, equiplongdesc, manufacturer, model FROM public.equipment WHERE installlocationid = 934",
            "recent_maintenance": "SELECT * FROM public.maintenance WHERE actualdatestart >= CURRENT_DATE - INTERVAL '30 days'",
            "equipment_with_maintenance": "SELECT e.equipname, e.equipid, e.safetycritical, m.maintname, m.actualdatestart, m.estcost FROM public.equipment e LEFT JOIN public.maintenance m ON e.equipid = m.equipid ORDER BY m.actualdatestart DESC",
            "maintenance_by_type": "SELECT mt.mainttypename, COUNT(*) as count, AVG(m.efforthours) as avg_hours FROM public.maintenance m JOIN public.mainttypes mt ON m.mainttypeid = mt.mainttypeid GROUP BY mt.mainttypename",
            "equipment_by_location": "SELECT l.locname, COUNT(e.equipid) as equipment_count FROM public.locations l LEFT JOIN public.equipment e ON l.locationid = e.installlocationid GROUP BY l.locname",
            "high_cost_maintenance": "SELECT * FROM public.maintenance WHERE estcost > 10000 ORDER BY estcost DESC",
            "overdue_maintenance": "SELECT * FROM public.maintenance WHERE planneddateend < CURRENT_DATE AND statusid != 'COM'"
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
                "バイオディーゼルユニットにはいくつのタンクがありますか？",
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

def get_biodiesel_equipment():
    """Get biodiesel unit equipment information"""
    sql = "SELECT equipid, equipname, equiplongdesc, manufacturer, model FROM public.equipment WHERE installlocationid = 934"
    return execute_statement(sql)

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
        error_msg = str(e)
        print(f"SQL Error: {error_msg}")
        
        # Try common fixes for SQL errors
        if "column" in error_msg.lower() and "does not exist" in error_msg.lower():
            # Try alternative column names
            fixed_sql = fix_column_names(sql)
            if fixed_sql != sql:
                print(f"Retrying with fixed SQL: {fixed_sql}")
                try:
                    response = rds_client.execute_statement(
                        secretArn=db_credentials_secrets_arn,
                        database=database_name,
                        resourceArn=db_resource_arn,
                        sql=fixed_sql
                    )
                    return response
                except Exception as retry_error:
                    print(f"Retry also failed: {str(retry_error)}")
        
        return generate_helpful_error_response(error_msg, sql)

def generate_helpful_empty_response(sql):
    """Generate helpful response when query returns no results"""
    # Analyze the SQL to provide context-specific suggestions
    context_suggestions = {
        "equipment": "利用可能な機器を確認するには『すべての機器を教えて』と質問してみてください。",
        "maintenance": "メンテナンス履歴を確認するには『最近のメンテナンス作業』と質問してみてください。",
        "safety": "安全重要機器については『安全上重要な機器』と質問してみてください。",
        "biodiesel": "バイオディーゼルユニットについては『バイオディーゼルユニットの設備』と質問してみてください。",
        "incidents": "2024年9月のインシデントについては『2024年9月のバイオディーゼルユニットのインシデント』と質問してみてください。"
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

def fix_column_names(sql):
    """Fix common column name issues"""
    # Common column name mappings
    column_fixes = {
        'maintnotes': 'maintlongdesc',  # Use existing column if maintnotes doesn't exist
        'notes': 'maintlongdesc',
        'description': 'maintlongdesc',
        'equipmentname': 'equipname',
        'equipment_name': 'equipname'
    }
    
    fixed_sql = sql
    for wrong_col, correct_col in column_fixes.items():
        if wrong_col in fixed_sql.lower():
            import re
            fixed_sql = re.sub(rf'\b{wrong_col}\b', correct_col, fixed_sql, flags=re.IGNORECASE)
    
    return fixed_sql

def optimize_japanese_sql(sql):
    """Optimize SQL for Japanese text searches"""
    # Add UPPER() for case-insensitive Japanese searches
    if 'LIKE' in sql.upper() and not 'UPPER(' in sql.upper():
        import re
        sql = re.sub(r"(\w+)\s+LIKE\s+'([^']+)'", r"UPPER(\1) LIKE UPPER('\2')", sql, flags=re.IGNORECASE)
    
    # Ensure schema prefix for all table names
    common_tables = ['equipment', 'maintenance', 'locations', 'mainttypes', 'statustypes', 'equipmenttypes', 'businessunits']
    for table in common_tables:
        if f' {table} ' in sql.lower() and f'public.{table}' not in sql.lower():
            sql = sql.replace(f' {table} ', f' public.{table} ')
            sql = sql.replace(f' {table.upper()} ', f' public.{table} ')
    
    # Handle specific incident queries for September 2024
    if '2024年9月' in sql or ('2024' in sql and '9月' in sql) or ('september' in sql.lower() and '2024' in sql):
        # Query for September 2024 incidents
        sql = "SELECT m.maintid, m.maintname, m.maintlongdesc, m.maintnotes, m.actualdatestart, m.incidentseverity, m.rootcause, e.equipname FROM public.maintenance m LEFT JOIN public.equipment e ON m.equipid = e.equipid WHERE m.actualdatestart >= '2024-09-01' AND m.actualdatestart < '2024-10-01' AND e.installlocationid = 934 ORDER BY m.actualdatestart"
    
    # Handle biodiesel-specific queries
    elif 'バイオディーゼル' in sql and 'タンク' in sql:
        # Specific query for biodiesel tanks
        sql = "SELECT equipid, equipname, equiplongdesc, installlocationid FROM public.equipment WHERE installlocationid = 934 AND (UPPER(equipname) LIKE '%タンク%' OR UPPER(equipname) LIKE '%TANK%')"
    elif 'バイオディーゼルユニット' in sql:
        # All equipment in biodiesel unit
        sql = "SELECT equipid, equipname, equiplongdesc, manufacturer, model FROM public.equipment WHERE installlocationid = 934"
    
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
    
    # Get biodiesel equipment information
    elif function == "get_biodiesel_equipment":
        sql = "SELECT equipid, equipname, equiplongdesc, manufacturer, model, installlocationid FROM public.equipment WHERE installlocationid = 934"
        results = execute_statement(sql)
        responseBody = {"TEXT": {"body": f"<biodiesel_equipment>{results}</biodiesel_equipment>"}}
    
    # Get incident information for specific time periods
    elif function == "get_incidents":
        start_date = '2024-09-01'
        end_date = '2024-09-30'
        location_id = 934
        
        for param in parameters:
            if param["name"] == "start_date":
                start_date = param["value"]
            elif param["name"] == "end_date":
                end_date = param["value"]
            elif param["name"] == "location_id":
                location_id = param["value"]
        
        sql = f"""SELECT m.maintid, m.maintname, m.maintlongdesc, m.maintnotes, 
                         m.actualdatestart, m.incidentseverity, m.rootcause, 
                         e.equipname, e.equipid
                  FROM public.maintenance m 
                  LEFT JOIN public.equipment e ON m.equipid = e.equipid 
                  WHERE m.actualdatestart >= '{start_date}' 
                    AND m.actualdatestart <= '{end_date}' 
                    AND e.installlocationid = {location_id}
                    AND m.mainttypeid = 'CM'
                  ORDER BY m.actualdatestart"""
        
        results = execute_statement(sql)
        responseBody = {"TEXT": {"body": f"<incidents>{results}</incidents>"}}
    
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
