# 📖 API Reference - Requests

## Base URL

```
https://motofix-service-requests.onrender.com
```

---

## Endpoints Overview

| Method | Endpoint | Purpose | Body Type |
|--------|----------|---------|-----------|
| POST | `/requests/` | Create request (text only) | JSON |
| POST | `/requests-with-media/` | Create request with files | FormData |
| GET | `/requests/` | List all requests | — |
| GET | `/requests/{id}` | Get single request | — |
| PATCH | `/requests/{id}/status` | Update request status | JSON |
| DELETE | `/requests/{id}` | Delete request | — |

---

## POST /requests/

**Create an area-based driver request without requiring GPS coordinates.**

### Request

```bash
curl -X POST https://motofix-service-requests.onrender.com/requests/ \
  -H "Authorization: Bearer <driver-access-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "service_type": "mechanic",
    "issue_type": "general",
    "description": null,
    "area_id": 15,
    "location_text": "Ntinda",
    "latitude": null,
    "longitude": null
  }'
```

### Body Parameters

| Name | Type | Required | Example |
|------|------|----------|---------|
| `service_type` | string | Yes | `"mechanic"` or `"tow"` |
| `area_id` | integer | One of `area_id` or `location_text` | `15` (Ntinda) |
| `location_text` | string or null | One of `area_id` or `location_text` | `"Near Ntinda market"` |
| `issue_type` | string | No | `"general"` (default), `"flat_tyre"`, `"battery"`, `"fuel"`, `"engine"`, `"other"` |
| `description` | string or null | No | `"Vehicle will not start"` |
| `latitude` | number or null | No | `null` |
| `longitude` | number or null | No | `null` |

The authenticated driver's ID is taken from the access token. Sending both location fields is allowed; GPS coordinates are optional.

### Response (200 OK; relevant fields)

```json
{
  "id": "1",
  "driver_id": 42,
  "status": "searching",
  "workflow_status": "pending",
  "service_type": "mechanic",
  "issue_type": "general",
  "description": null,
  "location": "Ntinda",
  "area_id": 15,
  "location_text": "Ntinda",
  "latitude": null,
  "longitude": null,
  "matched_mechanic_id": null,
  "matched_mechanic_name": null,
  "matched_mechanic_phone": null,
  "created_at": "2026-10-10T10:30:00",
  "updated_at": "2026-10-10T10:30:00",
  "media_files": []
}
```

The driver-facing `status` uses the v1 lifecycle; `workflow_status` preserves the
provider workflow value for compatibility. Other nullable legacy lifecycle fields
may also be present in the serialized response.

### Status Codes

- `200` - Request created, or the driver's existing active request returned
- `400` - Missing both `area_id` and `location_text`, or invalid service type
- `401` - Driver identity missing from the token
- `403` - Caller is not a driver
- `500` - Server error

---

## POST /requests-with-media/

**Create a service request with media files (voice, photos, documents).**

### Request

```bash
curl -X POST https://motofix-service-requests.onrender.com/requests-with-media/ \
  -F "customer_name=John Doe" \
  -F "phone=+256700123456" \
  -F "location=0.4500, 32.5800" \
  -F "description=Flat tire, can't ride" \
  -F "service_type=Other" \
  -F "media_files=@voice_note.webm" \
  -F "media_files=@photo.jpg" \
  -F "media_files=@invoice.pdf"
```

### Form Parameters

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `customer_name` | string | Yes | Driver's name |
| `phone` | string | Yes | Valid phone number |
| `location` | string | Yes | GPS coords or landmark |
| `description` | string | Yes | Issue description |
| `service_type` | string | Yes | "Other" (hardcoded) |
| `media_files` | file array | No | 0-10 files max |

### File Requirements

- **Voice Notes**: `.webm` audio files
- **Photos**: `.jpg`, `.png`, `.gif`
- **Documents**: Any file type
- **Max Size**: 10MB per file
- **Max Files**: 10 files per request

### Response (201 Created)

```json
{
  "id": "2",
  "customer_name": "John Doe",
  "phone": "+256700123456",
  "location": "0.4500, 32.5800",
  "description": "Flat tire, can't ride",
  "service_type": "Other",
  "status": "pending",
  "created_at": "2026-01-27T10:35:00Z",
  "media_files": [
    {
      "url": "https://res.cloudinary.com/.../voice_note.webm",
      "file_type": "voice",
      "size_kb": 45.2,
      "uploaded_at": "2026-01-27T10:35:01Z"
    },
    {
      "url": "https://res.cloudinary.com/.../photo.jpg",
      "file_type": "photo",
      "size_kb": 256.8,
      "uploaded_at": "2026-01-27T10:35:02Z"
    },
    {
      "url": "https://res.cloudinary.com/.../invoice.pdf",
      "file_type": "document",
      "size_kb": 128.5,
      "uploaded_at": "2026-01-27T10:35:03Z"
    }
  ]
}
```

### Status Codes

- `201` - Request created with media
- `400` - Invalid form data
- `413` - File too large
- `500` - Server error / upload failed

---

## GET /requests/

**List all service requests with their media files.**

### Request

```bash
curl -X GET https://motofix-service-requests.onrender.com/requests/
```

### Query Parameters

| Name | Type | Optional | Default |
|------|------|----------|---------|
| None | — | — | — |

### Response (200 OK)

```json
[
  {
    "id": "1",
    "customer_name": "John Doe",
    "phone": "+256700123456",
    "location": "0.4500, 32.5800",
    "description": "Flat tire",
    "service_type": "Other",
    "status": "pending",
    "created_at": "2026-01-27T10:30:00Z",
    "media_files": [
      {
        "url": "https://storage.../voice.webm",
        "file_type": "voice",
        "size_kb": 45.2,
        "uploaded_at": "2026-01-27T10:30:01Z"
      }
    ]
  },
  {
    "id": "2",
    "customer_name": "Jane Smith",
    "phone": "+256700999999",
    "location": "1.2300, 33.4500",
    "description": "Engine not starting",
    "service_type": "Other",
    "status": "accepted",
    "created_at": "2026-01-27T11:00:00Z",
    "media_files": []
  }
]
```

### Status Codes

- `200` - Success
- `500` - Server error

---

## GET /requests/{id}

**Get a single service request with its media files.**

### Request

```bash
curl -X GET https://motofix-service-requests.onrender.com/requests/1
```

### URL Parameters

| Name | Type | Required |
|------|------|----------|
| `id` | integer | Yes |

### Response (200 OK)

```json
{
  "id": "1",
  "customer_name": "John Doe",
  "phone": "+256700123456",
  "location": "0.4500, 32.5800",
  "description": "Flat tire on the left side",
  "service_type": "Other",
  "status": "pending",
  "created_at": "2026-01-27T10:30:00Z",
  "media_files": [
    {
      "url": "https://storage.../voice_1.webm",
      "file_type": "voice",
      "size_kb": 45.2,
      "uploaded_at": "2026-01-27T10:30:01Z"
    }
  ]
}
```

### Status Codes

- `200` - Success
- `404` - Request not found
- `500` - Server error

---

## PATCH /requests/{id}/status

**Update request status and trigger notifications.**

### Request

```bash
curl -X PATCH https://motofix-service-requests.onrender.com/requests/1/status \
  -H "Content-Type: application/json" \
  -d '{
    "status": "accepted"
  }'
```

### URL Parameters

| Name | Type | Required |
|------|------|----------|
| `id` | integer | Yes |

### Body Parameters

| Name | Type | Required | Options |
|------|------|----------|---------|
| `status` | string | Yes | "pending", "accepted", "en_route", "completed", "cancelled" |

### Response (200 OK)

```json
{
  "detail": "Status updated successfully",
  "new_status": "accepted"
}
```

### Status Codes

- `200` - Status updated
- `400` - Invalid status
- `404` - Request not found
- `500` - Server error

---

## DELETE /requests/{id}

**Delete a service request (and all associated media).**

### Request

```bash
curl -X DELETE https://motofix-service-requests.onrender.com/requests/1
```

### URL Parameters

| Name | Type | Required |
|------|------|----------|
| `id` | integer | Yes |

### Response (200 OK)

```json
{
  "detail": "Request deleted successfully"
}
```

### Status Codes

- `200` - Deleted successfully
- `404` - Request not found
- `500` - Server error

---

## Media File Object

Structure of `media_files` array elements:

```json
{
  "url": "https://res.cloudinary.com/cloud-name/voice_1.webm",
  "file_type": "voice",
  "size_kb": 45.2,
  "uploaded_at": "2026-01-27T10:30:01Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Direct download URL (can be accessed in browser) |
| `file_type` | string | "voice", "photo", or "document" |
| `size_kb` | float | File size in kilobytes |
| `uploaded_at` | string | ISO 8601 timestamp when uploaded |

---

## Error Responses

### 400 - Bad Request
```json
{
  "detail": "Invalid status. Allowed: pending, accepted, en_route, completed, cancelled"
}
```

### 404 - Not Found
```json
{
  "detail": "Request not found"
}
```

### 500 - Server Error
```json
{
  "detail": "Failed to upload files: Connection timeout"
}
```

---

## Response Codes Summary

| Code | Meaning |
|------|---------|
| 200 | OK - Request succeeded |
| 201 | Created - Request created successfully |
| 400 | Bad Request - Invalid parameters |
| 404 | Not Found - Resource doesn't exist |
| 413 | Payload Too Large - File too big |
| 500 | Internal Server Error - Server problem |

---

## Examples by Language

### JavaScript/Fetch

```javascript
// With FormData
const formData = new FormData();
formData.append('customer_name', 'John');
formData.append('phone', '+256700123456');
formData.append('media_files', voiceFile);
formData.append('media_files', photoFile);

const response = await fetch(
  'https://motofix-service-requests.onrender.com/requests-with-media/',
  {
    method: 'POST',
    body: formData
  }
);
const data = await response.json();
```

### Python/Requests

```python
import requests

files = [
    ('media_files', ('voice.webm', open('voice.webm', 'rb'), 'audio/webm')),
    ('media_files', ('photo.jpg', open('photo.jpg', 'rb'), 'image/jpeg'))
]

data = {
    'customer_name': 'John Doe',
    'phone': '+256700123456',
    'location': '0.4500, 32.5800',
    'description': 'Flat tire',
    'service_type': 'Other'
}

response = requests.post(
    'https://motofix-service-requests.onrender.com/requests-with-media/',
    data=data,
    files=files
)
print(response.json())
```

### cURL

```bash
curl -X POST https://motofix-service-requests.onrender.com/requests-with-media/ \
  -F "customer_name=John Doe" \
  -F "phone=+256700123456" \
  -F "location=0.4500, 32.5800" \
  -F "description=Flat tire" \
  -F "service_type=Other" \
  -F "media_files=@voice.webm" \
  -F "media_files=@photo.jpg"
```

---

## Rate Limiting

- No strict rate limits (can be added later)
- Recommended: 100 requests/minute per IP
- Monitor for abuse

---

## Authentication

Currently, no authentication required for:
- Creating requests
- Getting requests

Future: Add JWT token requirement

---

## CORS

Allowed origins:
- `https://motofix-driver-assist.onrender.com`
- `http://localhost:5173`
- `http://localhost:3000`
- `http://localhost:8080`

---

## Response Times

Typical response times:
- `/requests/` (GET): 50-200ms
- `/requests/{id}` (GET): 50-100ms
- `/requests/` (POST JSON): 100-300ms
- `/requests-with-media/` (POST with files): 2-5 seconds

---

## Changelog

### v1.0 (Jan 27, 2026)
- Initial release
- Added `/requests-with-media/` endpoint
- Added media file support
- Added Cloudinary integration
- Added AWS S3 support

---

## Support

For issues or questions:
1. Check logs: Backend logs show detailed error messages
2. Check database: Verify data was saved
3. Check cloud storage: Verify files were uploaded
4. Review this API reference

---

**Last Updated**: January 27, 2026  
**Version**: 1.0  
**Status**: Production Ready
