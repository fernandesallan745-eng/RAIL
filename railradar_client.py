"""
RailRadar API client — Phase 1
Docs: https://railradar.in/docs

Get your key: https://railradar.in/developers (free sandbox: 1,000 req/month)
Set it as an environment variable: export RAILRADAR_API_KEY="rr_live_..."
"""

import os
import requests

BASE_URL = "https://api.railradar.in/v1"


class RailRadarClient:
    def __init__(self, api_key: str = None):
        self.api_key = api_key or os.environ.get("RAILRADAR_API_KEY")
        if not self.api_key:
            raise ValueError(
                "No API key found. Set RAILRADAR_API_KEY env var or pass api_key=..."
            )
        self.session = requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {self.api_key}"})

    def get_live_status(
        self,
        train_number: str,
        date: str = None,
        geometry: bool = True,
        geometry_format: str = "geojson",
        include_coordinates: bool = True,
    ) -> dict:
        """
        Fetch live train running status.
        Returns: currentLocation (segmentProgress, speedKmh, bearingDegrees),
                 route (per-stop lat/lng, delay, speedToNextStationKmph), etc.
        """
        url = f"{BASE_URL}/trains/{train_number}/live"
        params = {
            "geometry": str(geometry).lower(),
            "format": geometry_format,
            "includeCoordinates": str(include_coordinates).lower(),
        }
        if date:
            params["date"] = date

        resp = self.session.get(url, params=params, timeout=15)
        resp.raise_for_status()
        payload = resp.json()

        if not payload.get("success"):
            raise RuntimeError(f"RailRadar error: {payload.get('error')}")

        return payload["data"]

    def get_route_geometry(self, train_number: str) -> dict:
        """
        Fetch high-resolution GeoJSON route geometry for a train.
        Use this to compute curvature per segment (see curvature.py).
        """
        url = f"{BASE_URL}/trains/{train_number}/route"
        resp = self.session.get(url, timeout=15)
        resp.raise_for_status()
        payload = resp.json()

        if not payload.get("success"):
            raise RuntimeError(f"RailRadar error: {payload.get('error')}")

        return payload["data"]

    def get_trains_between(self, from_code: str, to_code: str) -> dict:
        """Find trains between two stations — useful for 'opposite train' / 'preceding train' lookups."""
        url = f"{BASE_URL}/trains/between/{from_code}/{to_code}"
        resp = self.session.get(url, timeout=15)
        resp.raise_for_status()
        payload = resp.json()
        if not payload.get("success"):
            raise RuntimeError(f"RailRadar error: {payload.get('error')}")
        return payload["data"]


if __name__ == "__main__":
    # Quick smoke test — CSMT-Madgaon Vande Bharat (22229 down / 22230 up)
    client = RailRadarClient()
    data = client.get_live_status("22229")
    print("Train:", data["trainName"])
    print("Status:", data["status"], "| Delay (min):", data["delayMinutes"])
    loc = data["currentLocation"]
    print(
        f"Current: station={loc['stationCode']} "
        f"segmentProgress={loc['segmentProgress']} speed={loc['speedKmh']}km/h"
    )
