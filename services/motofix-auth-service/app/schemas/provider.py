# app/schemas/provider.py

from pydantic import BaseModel
from typing import List, Literal, Optional


class ProviderRegisterRequest(BaseModel):
    full_name: str
    phone: str
    password: str
    location: str
    latitude: float
    longitude: float
    specialty: Optional[str] = None
    provider_type: Literal["mechanic", "towing_provider"]
    vehicle_type: Optional[str] = "boda"
    service_area_ids: List[str] = []


class ProviderLoginRequest(BaseModel):
    identifier: str   # SPN (e.g. SPN001) or phone number (e.g. 0712345678)
    password: str


class ProviderOut(BaseModel):
    id: str
    full_name: str
    phone: str
    spn: Optional[str] = None
    specialty: Optional[str] = None
    provider_type: str
    rating: float
    jobs_completed: int
    is_verified: bool = False
    verification_status: str = "pending"
    service_area: Optional[str] = None
    specializations: List[str] = []
    password_changed: bool = False

    class Config:
        from_attributes = True


class ProviderLoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    provider: ProviderOut


class VerifyProviderRequest(BaseModel):
    decision: Literal["approved", "rejected"]
    provider_type: Literal["mechanic", "towing_provider"]
    reason: Optional[str] = None
