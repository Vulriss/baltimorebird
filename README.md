# Baltimore Bird

Web-based automotive data analysis platform for MF4/CAN bus data visualization and reporting.

[![Codacy Badge](https://app.codacy.com/project/badge/Grade/9761719c527d46cea247a9c0852a1f35)](https://app.codacy.com/gh/Vulriss/baltimorebird/dashboard?utm_source=gh&utm_medium=referral&utm_content=&utm_campaign=Badge_grade)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-7a60f4.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Python 3.10+](https://img.shields.io/badge/python-3.10+-7a60f4.svg)](https://www.python.org/downloads/)

![Baltimore Bird Interface](docs/screenshots/gui-overview.png)

**Live version:** [baltimorebird.cloud](https://baltimorebird.cloud)

## Project Goals

Baltimore Bird aims to provide engineers and analysts with a modern, accessible tool for exploring automotive time series data. The platform handles high-volume datasets with real-time visualization, removing the need for expensive proprietary software while maintaining professional-grade analysis capabilities.

Key objectives:
- Democratize access to automotive data analysis tools
- Deliver high-performance visualization without compromising on data fidelity
- Provide a secure, multi-tenant environment for teams to collaborate on vehicle data

## Features

- **Interactive EDA** — Drag-and-drop signal exploration with high-performance charting
- **Dashboard** — Visual block-based editor for building report templates
- **Reports** — View and export completed analysis results
- **Scripts** — Python script editor with secure sandbox execution
- **Conversion** — MF4 to CSV/Parquet, MF4 concatenation, calibration file converter
- **Multi-user** — Authentication and role management

## Documentation

- [User Guide](docs/user-guide.md)
- [API Reference](docs/API.md)
- [Deployment Guide](docs/deployment.md)

## Installation

### Backend setup
```bash
cd backend

# Virtual environment
python -m venv venv
source venv/bin/activate  # Linux/macOS
# or: venv\Scripts\activate  # Windows

# Dependencies
pip install -r requirements.txt

# Configuration
cp .env.example .env
nano .env  # Edit with your values

# Start server
python server.py
```

### Production configuration

Generate a secret key:
```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

Edit `.env`:
```env
AUTH_SECRET_KEY=your-generated-secret-key
AUTH_TOKEN_EXPIRY_HOURS=168
FLASK_ENV=production
FLASK_DEBUG=0
```

## Development
```bash
cd backend
FLASK_DEBUG=1 python server.py
```

Server starts at `http://localhost:5000`

To mimic production deployment locally, you can use this nginx configuration:
```nginx
server {
    listen 8080;
    server_name localhost;
    root /path/to/baltimore_bird/frontend;
    index index.html;

    client_max_body_size 1500M;

    location / {
        try_files $uri /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
        proxy_request_buffering off;
        proxy_buffering off;
        
        client_max_body_size 1500M;
    }
}
```

## Deployment

For production deployment:
- nginx (reverse proxy)
- gunicorn or uwsgi (WSGI server)
- SSL certificate (Let's Encrypt recommended)

See [Deployment Guide](docs/deployment.md) for detailed instructions.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
For bug reports or feature requests, please open an issue.

## License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

## Author

Geoffrey DOMERGUE