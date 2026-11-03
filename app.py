# app.py
import os
import uvicorn
from urllib.parse import unquote
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

app = FastAPI(title="Neurosynth Backend")

# 1. 參考你的範例：加入 CORS 標頭，允許跨來源請求
@app.middleware("http")
async def add_cors_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    return response

# 2. 資料庫連線配置 (自動相容 Render 的 postgres:// 連線字串)
_engine = None

def get_engine() -> Engine:
    global _engine
    if _engine is not None:
        return _engine
    db_url = os.getenv("DB_URL")
    if not db_url:
        raise RuntimeError("Missing DB_URL environment variable.")
    if db_url.startswith("postgres://"):
        db_url = "postgresql://" + db_url[len("postgres://"):]
    _engine = create_engine(db_url, pool_pre_ping=True)
    return _engine

def clean_term(term_str: str) -> str:
    """處理 URL 解碼，將底線轉換回空格並轉小寫"""
    decoded = unquote(term_str)
    return decoded.replace("_", " ").strip().lower()

def parse_coords(coord_str: str):
    """解析 x_y_z 座標為 (x, y, z) 整數 tuple"""
    parts = coord_str.strip().split("_")
    if len(parts) != 3:
        raise ValueError(f"座標格式錯誤 '{coord_str}'，應為 'x_y_z'（例如 0_-52_26）。")
    return int(parts[0]), int(parts[1]), int(parts[2])


# 3. 使用 HTMLResponse 實作根目錄健康檢查
@app.get("/", response_class=HTMLResponse)
async def health():
    return "<p>Server working!</p>"

# 圖片展示端點
@app.get("/img")
async def show_img():
    if not os.path.exists("amygdala.gif"):
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse("amygdala.gif", media_type="image/gif")

# 4. 作業核心端點 1: 詞彙解離 (Dissociate by Terms: A \ B)
@app.get("/dissociate/terms/{term_a:path}/{term_b:path}")
async def dissociate_terms(term_a: str, term_b: str):
    clean_a = clean_term(term_a)
    clean_b = clean_term(term_b)

    eng = get_engine()
    sql = text("""
        SELECT DISTINCT study_id 
        FROM ns.annotations_terms 
        WHERE LOWER(term) = :term_a
        EXCEPT
        SELECT DISTINCT study_id 
        FROM ns.annotations_terms 
        WHERE LOWER(term) = :term_b;
    """)

    try:
        with eng.connect() as conn:
            rows = conn.execute(sql, {"term_a": clean_a, "term_b": clean_b}).scalars().all()
        return {
            "term_a": clean_a,
            "term_b": clean_b,
            "count": len(rows),
            "studies": rows
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# 5. 作業核心端點 2: 座標解離 (Dissociate by Locations: Coord 1 \ Coord 2)
@app.get("/dissociate/locations/{coord_1}/{coord_2}")
async def dissociate_locations(coord_1: str, coord_2: str):
    try:
        x1, y1, z1 = parse_coords(coord_1)
        x2, y2, z2 = parse_coords(coord_2)
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))

    eng = get_engine()
    sql = text("""
        SELECT DISTINCT study_id 
        FROM ns.coordinates 
        WHERE ST_X(geom) = :x1 AND ST_Y(geom) = :y1 AND ST_Z(geom) = :z1
        EXCEPT
        SELECT DISTINCT study_id 
        FROM ns.coordinates 
        WHERE ST_X(geom) = :x2 AND ST_Y(geom) = :y2 AND ST_Z(geom) = :z2;
    """)

    try:
        with eng.connect() as conn:
            params = {"x1": x1, "y1": y1, "z1": z1, "x2": x2, "y2": y2, "z2": z2}
            rows = conn.execute(sql, params).scalars().all()
        return {
            "coord_1": [x1, y1, z1],
            "coord_2": [x2, y2, z2],
            "count": len(rows),
            "studies": rows
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# 6. 保留相容端點：單一查詢
@app.get("/terms/{term:path}/studies")
async def get_studies_by_term(term: str):
    clean_t = clean_term(term)
    eng = get_engine()
    sql = text("SELECT DISTINCT study_id FROM ns.annotations_terms WHERE LOWER(term) = :term;")
    try:
        with eng.connect() as conn:
            rows = conn.execute(sql, {"term": clean_t}).scalars().all()
        return {"term": clean_t, "count": len(rows), "studies": rows}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/locations/{coords}/studies")
async def get_studies_by_coordinates(coords: str):
    try:
        x, y, z = parse_coords(coords)
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))

    eng = get_engine()
    sql = text("SELECT DISTINCT study_id FROM ns.coordinates WHERE ST_X(geom) = :x AND ST_Y(geom) = :y AND ST_Z(geom) = :z;")
    try:
        with eng.connect() as conn:
            rows = conn.execute(sql, {"x": x, "y": y, "z": z}).scalars().all()
        return {"coords": [x, y, z], "count": len(rows), "studies": rows}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# 7. Smoke Test: 資料庫連接與筆數測試
@app.get("/test_db")
async def test_db():
    eng = get_engine()
    payload = {"ok": False, "dialect": eng.dialect.name}
    try:
        with eng.begin() as conn:
            conn.execute(text("SET search_path TO ns, public;"))
            payload["version"] = conn.exec_driver_sql("SELECT version()").scalar()
            payload["coordinates_count"] = conn.execute(text("SELECT COUNT(*) FROM ns.coordinates")).scalar()
            payload["metadata_count"] = conn.execute(text("SELECT COUNT(*) FROM ns.metadata")).scalar()
            payload["annotations_terms_count"] = conn.execute(text("SELECT COUNT(*) FROM ns.annotations_terms")).scalar()

            try:
                rows = conn.execute(text(
                    "SELECT study_id, ST_X(geom) AS x, ST_Y(geom) AS y, ST_Z(geom) AS z FROM ns.coordinates LIMIT 3"
                )).mappings().all()
                payload["coordinates_sample"] = [dict(r) for r in rows]
            except Exception:
                payload["coordinates_sample"] = []

            try:
                rows = conn.execute(text("SELECT * FROM ns.metadata LIMIT 3")).mappings().all()
                payload["metadata_sample"] = [dict(r) for r in rows]
            except Exception:
                payload["metadata_sample"] = []

            try:
                rows = conn.execute(text(
                    "SELECT study_id, contrast_id, term, weight FROM ns.annotations_terms LIMIT 3"
                )).mappings().all()
                payload["annotations_terms_sample"] = [dict(r) for r in rows]
            except Exception:
                payload["annotations_terms_sample"] = []

        payload["ok"] = True
        return payload
    except Exception as e:
        payload["error"] = str(e)
        return JSONResponse(status_code=500, content=payload)


# 8. 本機開發啟動區塊
if __name__ == "__main__":
    uvicorn.run(
        "app:app",  
        host="127.0.0.1",
        port=5000,
        reload=True,
    )