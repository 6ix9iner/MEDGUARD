import os
import sys
import zipfile
import xml.etree.ElementTree as ET

def extract_docx(docx_filename, output_dir=None):
    if not docx_filename.endswith('.docx'):
        print("Error: Please provide a file ending in .docx")
        sys.exit(1)
        
    if not os.path.exists(docx_filename):
        print(f"Error: File '{docx_filename}' not found in the current directory.")
        sys.exit(1)

    base_name = os.path.splitext(os.path.basename(docx_filename))[0]
    if not output_dir:
        output_dir = os.path.join(os.getcwd(), f"{base_name}_extracted")

    os.makedirs(output_dir, exist_ok=True)
    images_dir = os.path.join(output_dir, "images")
    os.makedirs(images_dir, exist_ok=True)

    print(f"Extracting '{docx_filename}' to '{output_dir}'...")

    try:
        with zipfile.ZipFile(docx_filename, 'r') as zip_ref:
            # 1. Extract Text from word/document.xml
            if 'word/document.xml' in zip_ref.namelist():
                xml_content = zip_ref.read('word/document.xml')
                root = ET.fromstring(xml_content)
                
                # Namespace mapping for Word XML
                namespaces = {
                    'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
                }
                
                paragraphs = []
                # Find all paragraph elements
                for paragraph_elem in root.findall('.//w:p', namespaces):
                    text_parts = []
                    # Find all text runs within paragraph
                    for text_elem in paragraph_elem.findall('.//w:t', namespaces):
                        if text_elem.text:
                            text_parts.append(text_elem.text)
                    if text_parts:
                        paragraphs.append("".join(text_parts))
                
                text_content = "\n\n".join(paragraphs)
                text_file_path = os.path.join(output_dir, "document_text.txt")
                with open(text_file_path, "w", encoding="utf-8") as f:
                    f.write(text_content)
                print(f"Successfully extracted text to: {text_file_path}")
            else:
                print("Warning: 'word/document.xml' not found. This might not be a valid Word document.")

            # 2. Extract Images
            image_count = 0
            for file_info in zip_ref.infolist():
                if file_info.filename.startswith('word/media/'):
                    filename = os.path.basename(file_info.filename)
                    if filename:
                        dest_path = os.path.join(images_dir, filename)
                        with open(dest_path, "wb") as f_out:
                            f_out.write(zip_ref.read(file_info.filename))
                        image_count += 1
            
            if image_count > 0:
                print(f"Successfully extracted {image_count} images to: {images_dir}")
            else:
                print("No images found in the document.")
                
    except Exception as e:
        print(f"An error occurred during extraction: {e}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python extract_docx.py <filename.docx>")
        sys.exit(1)
    
    extract_docx(sys.argv[1])
