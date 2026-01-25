import os
import re
import boto3
from dotenv import load_dotenv
from pathlib import Path
import urllib.parse

# 加載 R2 配置
load_dotenv(dotenv_path="/Users/jyuny1/blog/.env")

R2_ACCOUNT_ID = os.getenv("R2_ACCOUNT_ID")
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID")
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY")
R2_BUCKET_NAME = os.getenv("R2_BUCKET_NAME")
R2_PUBLIC_URL = (os.getenv("R2_PUBLIC_URL") or "").rstrip('/')

# 配置 S3 客戶端連線至 R2
s3 = boto3.client(
    service_name="s3",
    endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    region_name="auto",
)

def upload_to_r2(file_path, object_key):
    """檢查並上傳檔案至 R2"""
    try:
        # 簡單檢查檔案是否已存在
        s3.head_object(Bucket=R2_BUCKET_NAME, Key=object_key)
        # print(f"Skipping {object_key}, already exists.") 
    except:
        print(f"Uploading {object_key}...")
        try:
            s3.upload_file(file_path, R2_BUCKET_NAME, object_key)
            print(f"Uploaded {object_key}")
        except Exception as e:
            print(f"Failed to upload {object_key}: {e}")

def process_markdown(source_md_path, project_root, output_md_path, sub_folder):
    if not os.path.exists(source_md_path):
        print(f"Error: Source MD not found: {source_md_path}")
        return

    with open(source_md_path, 'r', encoding='utf-8') as f:
        content = f.read()

    def replace_link(match):
        original_link = match.group(0)
        
        # 解析路徑和檔名
        if original_link.startswith('![['):
            full_match = match.group(1)
            path_part = full_match.split('|')[0].strip()
        else:
            path_part = match.group(2)

        # 解碼路徑 (處理 %20 等)
        decoded_path = urllib.parse.unquote(path_part)
        
        # 組合本地絕對路徑
        # 假設連結是相對於 project_root 的完整路徑 (例如: 攝影/附件/file.jpg)
        candidate_path = os.path.join(project_root, decoded_path)
        
        if os.path.exists(candidate_path):
            filename = os.path.basename(candidate_path)
            
            # 定義 R2 上的儲存路徑 (Key): "資料夾名/檔名.jpg"
            r2_key = f"{sub_folder}/{filename}"
            
            # 上傳至 R2
            upload_to_r2(candidate_path, r2_key)
            
            # 生成新的公開 URL
            # 注意：URL 路徑部分需要編碼
            encoded_key = urllib.parse.quote(r2_key)
            new_url = f"{R2_PUBLIC_URL}/{encoded_key}"
            
            return f"![{filename}]({new_url})"
        else:
            print(f"Warning: Image not found: {decoded_path}")
            # 如果找不到檔案，保留原樣，或者您可以選擇註解掉
            return original_link

    # Regex 1: ![[content]]
    content = re.sub(r'!\[\[(.*?)\]\]', replace_link, content)
    # Regex 2: ![alt](path)
    content = re.sub(r'!\[(.*?)\]\((.*?)\)', replace_link, content)

    # 確保輸出目錄存在
    os.makedirs(os.path.dirname(output_md_path), exist_ok=True)
    with open(output_md_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"Done! Processed file saved to: {output_md_path}")

if __name__ == "__main__":
    # 配置
    PROJECT_ROOT = "/Users/jyuny1/Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidan-thinking"
    SOURCE_MD = os.path.join(PROJECT_ROOT, "攝影/照片的本質精讀.md")
    OUTPUT_MD = "/Users/jyuny1/blog/content/Shore-Nature-of-Photographs.md"
    
    # 子資料夾名稱 (將作為 R2 中的資料夾名稱)
    # 建議使用英文、數字、連字符，避免特殊字符
    SUB_FOLDER = "nature-of-photographs" 

    process_markdown(SOURCE_MD, PROJECT_ROOT, OUTPUT_MD, SUB_FOLDER)
